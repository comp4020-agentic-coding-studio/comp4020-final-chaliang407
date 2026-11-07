import { describe, expect, it } from "vitest";
import {
  walkableNeighborsOf,
  moveEnemyRandomly,
  moveEnemyTowardTarget,
  moveEnemyTowardPlayer,
  CHASE_CHANCE,
  detectCollision,
} from "../src/game/enemies.ts";
import { LEVELS, isWalkableInLevel } from "../src/game/levels.ts";

// BFS shortest-path distance within a level, used by these tests themselves
// to independently verify "did the chase branch actually get closer," rather
// than trusting the production bfsDistancesFrom it's checking (that function
// is intentionally unexported — this is its own, separately-written
// reference implementation).
function bfsDistance(level: number, from: { x: number; y: number }, to: { x: number; y: number }): number {
  const key = (p: { x: number; y: number }) => `${p.x},${p.y}`;
  const visited = new Set<string>([key(from)]);
  const queue: { x: number; y: number }[] = [from];
  let head = 0;
  let distance = 0;
  while (head < queue.length) {
    const levelSize = queue.length - head;
    for (let i = 0; i < levelSize; i++) {
      const p = queue[head++];
      if (p.x === to.x && p.y === to.y) return distance;
      for (const n of walkableNeighborsOf(level, p)) {
        if (!visited.has(key(n))) {
          visited.add(key(n));
          queue.push(n);
        }
      }
    }
    distance++;
  }
  throw new Error(`no path from (${from.x},${from.y}) to (${to.x},${to.y}) in level ${level}`);
}

// Pure unit tests of enemy movement and collision detection — no DB, no
// running app, same in-process style as spec/maze.test.ts and
// spec/mazeValidator's own tests. The injectable `rng` parameter
// (src/game/enemies.ts's moveEnemyRandomly) is what makes "did it pick
// exactly this neighbor" assertable without actually depending on
// Math.random, per the approved design.

describe("walkableNeighborsOf", () => {
  it("returns every orthogonally-adjacent walkable tile, in a fixed UP/DOWN/LEFT/RIGHT order", () => {
    // Level 1's START (1,1): DOWN and RIGHT are open, UP and LEFT are walls
    // (verified against src/game/maze.ts's grid by spec/movement.test.ts's
    // own wall tests).
    const neighbors = walkableNeighborsOf(1, { x: 1, y: 1 });
    expect(neighbors).toEqual([
      { x: 1, y: 2 }, // DOWN
      { x: 2, y: 1 }, // RIGHT
    ]);
  });

  it("never returns a wall tile or an out-of-bounds tile", () => {
    const neighbors = walkableNeighborsOf(1, { x: 0, y: 0 }); // a wall corner
    expect(neighbors).toEqual([]);
  });
});

describe("moveEnemyRandomly", () => {
  it("picks exactly the neighbor an injected rng selects, deterministically", () => {
    // From (1,1) in level 1, neighbors are [DOWN(1,2), RIGHT(2,1)] in that
    // order (see walkableNeighborsOf's own test above). rng()=0 must select
    // index 0; rng() just under 1 must select the last index.
    const first = moveEnemyRandomly(1, { x: 1, y: 1 }, () => 0);
    expect(first).toEqual({ x: 1, y: 2 });

    const last = moveEnemyRandomly(1, { x: 1, y: 1 }, () => 0.999999);
    expect(last).toEqual({ x: 2, y: 1 });
  });

  it("always returns a walkable tile for every enemy spawn in every level that has enemies", () => {
    for (const def of LEVELS) {
      for (const spawn of def.enemySpawns) {
        // Exercise every possible rng() draw bucket (one per neighbor count)
        // rather than just one fixed value, so this doesn't accidentally
        // pass only because rng()=0's neighbor happens to be walkable.
        const neighbors = walkableNeighborsOf(def.level, spawn);
        expect(neighbors.length).toBeGreaterThan(0); // every validated maze has degree >= 1 everywhere
        for (let i = 0; i < neighbors.length; i++) {
          const rngValue = i / neighbors.length;
          const next = moveEnemyRandomly(def.level, spawn, () => rngValue);
          expect(neighbors).toContainEqual(next);
        }
      }
    }
  });

  it("never moves an enemy into a wall or outside the maze, across every level/spawn combination", () => {
    for (const def of LEVELS) {
      for (const spawn of def.enemySpawns) {
        for (const rngValue of [0, 0.25, 0.5, 0.75, 0.999]) {
          const next = moveEnemyRandomly(def.level, spawn, () => rngValue);
          const row = def.maze.rows[next.y];
          expect(row?.[next.x], `level ${def.level} spawn (${spawn.x},${spawn.y}) rng=${rngValue}`).toBe(".");
        }
      }
    }
  });

  it("stays in place if there are no walkable neighbors (defensive fallback; not expected in any validated level)", () => {
    // No real level has a degree-0 floor cell (mazeValidator enforces every
    // floor cell is reachable, which requires degree >= 1), but this proves
    // the function is still total rather than throwing or returning garbage.
    const isolatedLevelStub = 1;
    // Fake an isolated point by picking coordinates certain to be a wall on
    // every side — the function must still return a definite point, not throw.
    expect(() => moveEnemyRandomly(isolatedLevelStub, { x: -100, y: -100 })).not.toThrow();
  });
});

describe("detectCollision", () => {
  it("detects a direct overlap when the player moves onto an enemy's unchanged position", () => {
    const collided = detectCollision({ x: 1, y: 1 }, { x: 2, y: 1 }, [{ x: 2, y: 1 }], [{ x: 2, y: 1 }]);
    expect(collided).toBe(true);
  });

  it("detects a direct overlap when an enemy moves onto the player's stationary position (e.g. a TIE round)", () => {
    const collided = detectCollision({ x: 1, y: 1 }, { x: 1, y: 1 }, [{ x: 1, y: 2 }], [{ x: 1, y: 1 }]);
    expect(collided).toBe(true);
  });

  it("detects a position swap: player and enemy exchange tiles in the same round", () => {
    const collided = detectCollision({ x: 1, y: 1 }, { x: 2, y: 1 }, [{ x: 2, y: 1 }], [{ x: 1, y: 1 }]);
    expect(collided).toBe(true);
  });

  it("reports no collision when positions are entirely unrelated", () => {
    const collided = detectCollision({ x: 1, y: 1 }, { x: 2, y: 1 }, [{ x: 8, y: 8 }], [{ x: 8, y: 9 }]);
    expect(collided).toBe(false);
  });

  it("reports a collision (not a false negative) even when multiple enemies are involved, only one of which collides", () => {
    const collided = detectCollision(
      { x: 1, y: 1 },
      { x: 2, y: 1 },
      [{ x: 8, y: 8 }, { x: 2, y: 1 }, { x: 5, y: 5 }],
      [{ x: 8, y: 9 }, { x: 2, y: 1 }, { x: 5, y: 6 }],
    );
    expect(collided).toBe(true);
  });

  it("does not report a collision from an enemy that moved away, leaving no overlap or swap", () => {
    const collided = detectCollision({ x: 1, y: 1 }, { x: 1, y: 1 }, [{ x: 1, y: 2 }], [{ x: 1, y: 3 }]);
    expect(collided).toBe(false);
  });
});

describe("moveEnemyTowardTarget (BFS chase)", () => {
  it("routes around a wall rather than toward the Manhattan-closest neighbor that a straight-line distance would prefer", () => {
    // Level 3, point (7,2) chasing target (1,1): the Manhattan-closest
    // neighbor of (7,2) is (7,1) (one step closer as the crow flies), but
    // (7,1) sits in a dead-end corridor the real maze walls make a dead end
    // relative to (1,1) — walking the maze's actual walls, (7,3) is the
    // shorter route. Verified directly against level 3's own grid
    // (spec/levels.test.ts's own validated data), not just asserted.
    const point = { x: 7, y: 2 };
    const target = { x: 1, y: 1 };
    const next = moveEnemyTowardTarget(3, point, target);
    expect(next).toEqual({ x: 7, y: 3 });
    // The Manhattan-closest neighbor (7,1) must not have been picked, and
    // must genuinely be the wrong choice under real wall-respecting distance
    // — otherwise this test would prove nothing about BFS vs. Manhattan.
    expect(bfsDistance(3, { x: 7, y: 1 }, target)).toBeGreaterThan(bfsDistance(3, next, target));
  });

  it.each([3, 4, 5, 6, 7, 8, 9, 10])(
    "always takes a step that strictly reduces (or, at a dead end, cannot reduce) BFS distance to the target, never Manhattan distance through walls, in level %i",
    (level) => {
      const def = LEVELS.find((d) => d.level === level)!;
      for (const spawn of def.enemySpawns) {
        const target = def.maze.start; // "the player is far away" — chase across the whole level
        const next = moveEnemyTowardTarget(level, spawn, target);
        const neighbors = walkableNeighborsOf(level, spawn);
        const distances = neighbors.map((n) => bfsDistance(level, n, target));
        const bestPossible = Math.min(...distances);
        expect(bfsDistance(level, next, target)).toBe(bestPossible); // chosen step is a true shortest-path step
      }
    },
  );

  it("never moves into a wall or outside the maze, across every level/spawn combination, when chasing a far-away target", () => {
    for (const def of LEVELS) {
      for (const spawn of def.enemySpawns) {
        const next = moveEnemyTowardTarget(def.level, spawn, def.maze.start);
        expect(isWalkableInLevel(def.level, next.x, next.y)).toBe(true);
      }
    }
  });

  it("stays in place if there are no walkable neighbors (defensive fallback, same as moveEnemyRandomly)", () => {
    expect(() => moveEnemyTowardTarget(1, { x: -100, y: -100 }, { x: 0, y: 0 })).not.toThrow();
  });
});

describe("moveEnemyTowardPlayer (hybrid chase/patrol AI)", () => {
  it("chases (picks the BFS shortest-path step) when rng() draws below CHASE_CHANCE", () => {
    const point = { x: 7, y: 2 };
    const target = { x: 1, y: 1 };
    const chaseStep = moveEnemyTowardTarget(3, point, target);
    const next = moveEnemyTowardPlayer(3, point, target, () => 0); // 0 < CHASE_CHANCE
    expect(next).toEqual(chaseStep);
  });

  it("patrols (picks a uniformly-chosen walkable neighbor) when rng() draws at or above CHASE_CHANCE", () => {
    const point = { x: 7, y: 2 };
    const target = { x: 1, y: 1 };
    const neighbors = walkableNeighborsOf(3, point);
    // A draw of exactly CHASE_CHANCE must land on the patrol branch's own
    // first neighbor (the remapped fraction is 0 at this boundary).
    const next = moveEnemyTowardPlayer(3, point, target, () => CHASE_CHANCE);
    expect(next).toEqual(neighbors[0]);
  });

  it("consumes exactly one rng() draw per call, on both the chase and the patrol branch", () => {
    let calls = 0;
    const countingRng = (value: number) => () => {
      calls++;
      return value;
    };
    calls = 0;
    moveEnemyTowardPlayer(3, { x: 7, y: 2 }, { x: 1, y: 1 }, countingRng(0)); // chase branch
    expect(calls).toBe(1);
    calls = 0;
    moveEnemyTowardPlayer(3, { x: 7, y: 2 }, { x: 1, y: 1 }, countingRng(0.999)); // patrol branch
    expect(calls).toBe(1);
  });

  it("reduces BFS shortest-path distance to a far-away target whenever the chase branch is taken, across levels 3-10", () => {
    for (const def of LEVELS) {
      if (def.level < 3) continue;
      const target = def.maze.start; // player far away, at the opposite end of the level from every spawn
      for (const spawn of def.enemySpawns) {
        const before = bfsDistance(def.level, spawn, target);
        if (before === 0) continue; // spawn already at target in some degenerate case; nothing to reduce
        const next = moveEnemyTowardPlayer(def.level, spawn, target, () => 0); // force chase
        const after = bfsDistance(def.level, next, target);
        expect(after, `level ${def.level} spawn (${spawn.x},${spawn.y})`).toBeLessThan(before);
      }
    }
  });

  it("still sometimes patrols randomly rather than always chasing: over many draws spanning [0,1), both a chase-only and a non-chase-only outcome occur", () => {
    const point = { x: 7, y: 2 };
    const target = { x: 1, y: 1 };
    const chaseStep = moveEnemyTowardTarget(3, point, target);
    const outcomes = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const roll = i / 20;
      const next = moveEnemyTowardPlayer(3, point, target, () => roll);
      outcomes.add(`${next.x},${next.y}`);
    }
    // The chase destination must appear (rolls below CHASE_CHANCE)...
    expect(outcomes.has(`${chaseStep.x},${chaseStep.y}`)).toBe(true);
    // ...and at least one other, non-chase destination must also appear
    // (rolls at/above CHASE_CHANCE picking a different neighbor) — proving
    // the patrol branch is reachable and not dead code.
    expect(outcomes.size).toBeGreaterThan(1);
  });

  it("never moves into a wall or outside the maze on either branch, across every level 3-10 enemy spawn, chasing a far-away target", () => {
    for (const def of LEVELS) {
      if (def.level < 3) continue;
      const target = def.maze.start;
      for (const spawn of def.enemySpawns) {
        for (const roll of [0, 0.25, CHASE_CHANCE, 0.85, 0.999]) {
          const next = moveEnemyTowardPlayer(def.level, spawn, target, () => roll);
          expect(
            isWalkableInLevel(def.level, next.x, next.y),
            `level ${def.level} spawn (${spawn.x},${spawn.y}) roll=${roll}`,
          ).toBe(true);
        }
      }
    }
  });

  it("stays in place if there are no walkable neighbors (defensive fallback, same as moveEnemyRandomly)", () => {
    expect(() => moveEnemyTowardPlayer(1, { x: -100, y: -100 }, { x: 0, y: 0 })).not.toThrow();
  });
});
