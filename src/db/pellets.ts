import type Database from "better-sqlite3";

export const PELLET_POINTS = 10;

export interface PelletRow {
  level: number;
  x: number;
  y: number;
  collected: boolean;
}

interface RawPelletRow {
  level: number;
  x: number;
  y: number;
  collected: number;
}

function fromRow(row: RawPelletRow): PelletRow {
  return { level: row.level, x: row.x, y: row.y, collected: row.collected === 1 };
}

// Every pellet for a level, collected or not — used to build the public
// state payload (src/api.ts), which is always safe to show in full: unlike
// an open round's vote tally, pellet positions and collection state are
// world state, not something a hidden-vote rule applies to.
export function getPellets(db: Database.Database, level: number): PelletRow[] {
  return (
    db.prepare("SELECT level, x, y, collected FROM pellet_state WHERE level = ? ORDER BY y, x").all(level) as RawPelletRow[]
  ).map(fromRow);
}

// Marks the pellet at (level, x, y) collected and returns whether this call
// is the one that actually did so — `false` for a tile with no pellet at
// all, and `false` again for a pellet that was already collected (by an
// earlier round, or, in principle, by this same call racing another — see
// collectPelletAt's own comment for why that race can't actually happen).
// The UPDATE's `AND collected = 0` guard is what makes a second call on an
// already-collected pellet a true no-op rather than a second, duplicate
// award: scoring reads this return value, never the mere presence of a
// pellet at a tile, to decide whether to add points.
export function collectPelletAt(db: Database.Database, level: number, x: number, y: number): boolean {
  const result = db
    .prepare("UPDATE pellet_state SET collected = 1 WHERE level = ? AND x = ? AND y = ? AND collected = 0")
    .run(level, x, y);
  return result.changes > 0;
}

// Marks every pellet, across all ten levels, uncollected again — used only
// by restartGame (see src/game/lifecycle.ts), inside that function's own
// transaction, so a crash partway through a restart can't leave some
// levels' pellets reset and others still collected.
export function resetAllPellets(db: Database.Database): void {
  db.prepare("UPDATE pellet_state SET collected = 0").run();
}
