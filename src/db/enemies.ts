import type Database from "better-sqlite3";
import { LEVELS } from "../game/levels.ts";
import { moveEnemyTowardPlayer } from "../game/enemies.ts";
import type { Point } from "../game/maze.ts";

export interface EnemyRow {
  level: number;
  indexInLevel: number;
  x: number;
  y: number;
}

interface RawEnemyRow {
  level: number;
  index_in_level: number;
  x: number;
  y: number;
}

function fromRow(row: RawEnemyRow): EnemyRow {
  return { level: row.level, indexInLevel: row.index_in_level, x: row.x, y: row.y };
}

// Every enemy for a level, at its current (server-authoritative) position —
// world state, always safe to expose in full, exactly like pellets and
// character position already are.
export function getEnemies(db: Database.Database, level: number): EnemyRow[] {
  return (
    db
      .prepare("SELECT level, index_in_level, x, y FROM enemies WHERE level = ? ORDER BY index_in_level")
      .all(level) as RawEnemyRow[]
  ).map(fromRow);
}

// Moves every enemy belonging to `level` exactly one walkable tile toward
// `target` (the player's own position at the start of this round, before
// this round's move is applied — see src/db/character.ts's
// applyRoundResultDetailed, the only caller), persists the new positions,
// and returns the before/after position pairs — the caller uses the
// returned pairs to run collision detection against the player's own
// before/after position in the same round, without a second read of the
// table it just wrote. `rng` defaults to Math.random; tests inject a
// deterministic fake (src/game/enemies.ts's moveEnemyTowardPlayer is where
// that's actually consumed, exactly one draw per enemy).
//
// Deterministic tie-breaking rule, documented per the milestone's own
// requirement to handle "enemies choosing the same destination" explicitly
// rather than leaving it unspecified: each enemy moves independently, in
// index_in_level order, drawing its own chase/patrol roll from its own
// rng() call — there is no coordination between enemies and no
// collision-avoidance between them. Two enemies' walkable-neighbor lists can
// overlap, and moveEnemyTowardPlayer's choice over each enemy's own list can
// send two different enemies onto the same tile, or onto the tile the other
// enemy just vacated; this is allowed and intentionally unresolved —
// enemy-enemy overlap has no gameplay meaning here (only player-enemy
// contact triggers a collision, per detectCollision), so there is nothing to
// arbitrate. The "same choice" a reader might otherwise expect to need
// tie-breaking for is really just "two independent draws happened to land
// on the same tile," not a contested single resource.
export function moveLevelEnemies(
  db: Database.Database,
  level: number,
  target: Point,
  rng: () => number = Math.random,
): { before: EnemyRow; after: EnemyRow }[] {
  const enemies = getEnemies(db, level);
  const update = db.prepare("UPDATE enemies SET x = ?, y = ? WHERE level = ? AND index_in_level = ?");
  const moves: { before: EnemyRow; after: EnemyRow }[] = [];
  for (const enemy of enemies) {
    const next = moveEnemyTowardPlayer(level, { x: enemy.x, y: enemy.y }, target, rng);
    update.run(next.x, next.y, enemy.level, enemy.indexInLevel);
    moves.push({ before: enemy, after: { ...enemy, x: next.x, y: next.y } });
  }
  return moves;
}

// Resets every enemy, across all ten levels, back to its fixed spawn
// position from src/game/levels.ts — used only by restartGame (see
// src/game/lifecycle.ts), inside that function's own transaction, so a
// crash partway through can't leave some levels' enemies reset and others
// not. This is the one place a moved enemy's position gets undone.
export function resetAllEnemiesToSpawn(db: Database.Database): void {
  const update = db.prepare("UPDATE enemies SET x = ?, y = ? WHERE level = ? AND index_in_level = ?");
  for (const def of LEVELS) {
    def.enemySpawns.forEach((spawn, index) => {
      update.run(spawn.x, spawn.y, def.level, index);
    });
  }
}
