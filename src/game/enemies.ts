import { isWalkableInLevel, stepInLevel } from "./levels.ts";
import type { Point } from "./maze.ts";

const DIRECTIONS = ["UP", "DOWN", "LEFT", "RIGHT"] as const;

// Every orthogonally-adjacent tile of `point` that's walkable in `level` —
// the candidate set an enemy picks its next move from. Ordered UP, DOWN,
// LEFT, RIGHT, always, regardless of which directions happen to be
// walkable — this fixed ordering is what makes `rng` index 0 deterministic
// across calls and across identical enemies (see moveEnemyRandomly's own
// comment on why two enemies facing the same choice get the same outcome
// from the same rng() draw, by design, not by accident).
export function walkableNeighborsOf(level: number, point: Point): Point[] {
  return DIRECTIONS.map((d) => stepInLevel(point, d)).filter((n) => isWalkableInLevel(level, n.x, n.y));
}

// Picks exactly one orthogonal neighbor uniformly at random via `rng`
// (defaults to Math.random; tests inject a deterministic fake so "which
// neighbor gets picked" is assertable exactly, per the project's existing
// pattern for anything else that needs determinism under test — see
// src/db/client.ts's migration tests for the same injectable-dependency
// style applied to time instead of randomness). The server is the only
// place this ever runs: a client never sees anything but the resulting
// persisted position (src/db/enemies.ts), so there is no channel for a
// client to simulate or predict this choice independently.
//
// If an enemy has zero walkable neighbors (not possible in any of this
// project's validated levels — every floor cell has degree >= 1 by
// construction, see src/game/mazeValidator.ts — but guarded here rather
// than assumed), it stays at `point`, the same "nowhere to go" no-op the
// player's own wall-blocked movement already uses.
export function moveEnemyRandomly(level: number, point: Point, rng: () => number = Math.random): Point {
  const neighbors = walkableNeighborsOf(level, point);
  if (neighbors.length === 0) return point;
  const index = Math.floor(rng() * neighbors.length);
  // Defends only against a pathological rng() returning exactly 1 (or
  // something out of [0,1) by a caller's bug) — a correct Math.random()-like
  // source never does this, but the fallback keeps the function total rather
  // than ever indexing out of bounds.
  return neighbors[Math.min(index, neighbors.length - 1)];
}

function pointKey(p: Point): string {
  return `${p.x},${p.y}`;
}

// Breadth-first distance from `source` to every floor cell this level's
// walkable graph can reach, respecting walls — the one correct way to answer
// "how many tiles away is the player," since Manhattan distance alone can't
// tell a straight corridor from a wall standing directly between two cells
// that happen to be close as the crow flies. Returns a map keyed by "x,y" to
// its distance from `source` (0 for `source` itself); every validated level
// is fully connected (src/game/mazeValidator.ts), so in practice every floor
// cell ends up in the map, but a cell this graph genuinely can't reach is
// simply absent rather than reported with a fabricated distance.
function bfsDistancesFrom(level: number, source: Point): Map<string, number> {
  const distances = new Map<string, number>([[pointKey(source), 0]]);
  const queue: Point[] = [source];
  let head = 0;
  while (head < queue.length) {
    const current = queue[head++];
    const currentDistance = distances.get(pointKey(current))!;
    for (const neighbor of walkableNeighborsOf(level, current)) {
      const key = pointKey(neighbor);
      if (!distances.has(key)) {
        distances.set(key, currentDistance + 1);
        queue.push(neighbor);
      }
    }
  }
  return distances;
}

// The "chase" half of the hybrid AI: among `point`'s own walkable
// neighbors, picks whichever one has the smallest BFS shortest-path
// distance to `target` (computed by walking the maze's real walls, never by
// Manhattan distance through them). A neighbor the target can't reach at all
// (never happens in a validated, fully-connected level, but `target` is
// caller-supplied) is treated as infinitely far, so it's only ever chosen if
// every neighbor is equally unreachable. Ties among equally-close neighbors
// are broken by walkableNeighborsOf's own fixed UP/DOWN/LEFT/RIGHT order —
// deterministic given `level`/`point`/`target` alone, no randomness
// involved in this half of the decision at all.
export function moveEnemyTowardTarget(level: number, point: Point, target: Point): Point {
  const neighbors = walkableNeighborsOf(level, point);
  if (neighbors.length === 0) return point;
  const distances = bfsDistancesFrom(level, target);
  let best = neighbors[0];
  let bestDistance = distances.get(pointKey(best)) ?? Infinity;
  for (let i = 1; i < neighbors.length; i++) {
    const candidate = neighbors[i];
    const candidateDistance = distances.get(pointKey(candidate)) ?? Infinity;
    if (candidateDistance < bestDistance) {
      best = candidate;
      bestDistance = candidateDistance;
    }
  }
  return best;
}

// Fraction of resolved rounds an enemy spends chasing rather than patrolling
// — a project-level tuning constant, not something a caller should vary per
// call (every enemy, every level, uses the same split), so it's exported
// once here rather than threaded through every function signature that
// needs it.
export const CHASE_CHANCE = 0.7;

// The hybrid AI itself: CHASE_CHANCE of the time, takes one BFS
// shortest-path step toward `target` (src/db/enemies.ts's moveLevelEnemies
// passes the player's own current position); the rest of the time, takes
// one uniformly-random walkable step, so an enemy still sometimes wanders
// rather than beelining the player every round, and can't camp a single
// corridor indefinitely waiting for it.
//
// Consumes exactly one rng() draw per call, on both branches — preserving
// moveLevelEnemies' own pre-existing contract ("each enemy moves
// independently... drawing its own candidate-neighbor index from its own
// rng() call") rather than introducing a second, conditional draw that would
// silently change how many times rng() is called depending on which branch
// is taken. The single draw is split into two sub-ranges instead: a value
// below CHASE_CHANCE selects the chase branch outright; a value at or above
// it is linearly remapped back onto [0, 1) (via `(roll - CHASE_CHANCE) / (1
// - CHASE_CHANCE)`) and used exactly as moveEnemyRandomly's own draw would
// be, to pick uniformly among the walkable neighbors for the patrol branch.
export function moveEnemyTowardPlayer(
  level: number,
  point: Point,
  target: Point,
  rng: () => number = Math.random,
): Point {
  const neighbors = walkableNeighborsOf(level, point);
  if (neighbors.length === 0) return point;
  const roll = rng();
  if (roll < CHASE_CHANCE) {
    return moveEnemyTowardTarget(level, point, target);
  }
  const patrolRoll = (roll - CHASE_CHANCE) / (1 - CHASE_CHANCE);
  const index = Math.floor(patrolRoll * neighbors.length);
  return neighbors[Math.min(index, neighbors.length - 1)];
}

export interface CollisionResult {
  collided: boolean;
}

// A collision happens if, comparing each enemy's position before this
// round's moves to its position after, together with the player's own
// before/after position, any of:
//   - the player's final tile equals an enemy's final tile (either moved
//     onto the other, including an enemy moving onto a stationary player —
//     e.g. a TIE round, or a player blocked by a wall)
//   - the player and an enemy swapped tiles during the same round (each
//     ends up where the other started)
// Multiple enemies can each independently satisfy this in the same round;
// the caller (src/db/character.ts) applies at most one penalty regardless
// of how many enemies are implicated, by only ever checking *whether* a
// collision occurred, not counting how many.
export function detectCollision(
  playerBefore: Point,
  playerAfter: Point,
  enemiesBefore: readonly Point[],
  enemiesAfter: readonly Point[],
): boolean {
  for (let i = 0; i < enemiesAfter.length; i++) {
    const before = enemiesBefore[i];
    const after = enemiesAfter[i];
    if (after.x === playerAfter.x && after.y === playerAfter.y) return true;
    if (before.x === playerAfter.x && before.y === playerAfter.y && after.x === playerBefore.x && after.y === playerBefore.y) {
      return true;
    }
  }
  return false;
}
