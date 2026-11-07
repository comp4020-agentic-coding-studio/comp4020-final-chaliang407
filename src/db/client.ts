import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA } from "./schema.ts";
import { DB_PATH } from "../config.ts";
import { START } from "../game/maze.ts";
import { LEVELS } from "../game/levels.ts";

let db: Database.Database | undefined;

function ensureCharacter(db: Database.Database): void {
  db.prepare(
    "INSERT OR IGNORE INTO character (id, x, y, won, updated_at) VALUES (1, ?, ?, 0, ?)",
  ).run(START.x, START.y, new Date().toISOString());
}

// SQLite CHECK constraints can't be altered in place, and the old 1D
// position/level shape has no meaningful, non-lossy mapping onto a 2D maze
// cell, so a database built before the maze (character.position/level,
// rounds/votes CHECK-ing the old LEFT/JUMP/RIGHT action set) can't be
// upgraded in place. Detected by the absence of character.x, the new shape's
// marker column.
const LEGACY_SUFFIX = "_legacy_pre_maze";

function needsMigration(db: Database.Database): boolean {
  const hasCharacterTable = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'character'")
    .get();
  if (!hasCharacterTable) return false;
  const columns = db.prepare("PRAGMA table_info('character')").all() as { name: string }[];
  return !columns.some((c) => c.name === "x");
}

function tableExists(db: Database.Database, name: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined
  );
}

// A once-per-database migration error: the archive slot this migration needs
// to write to is already occupied, so proceeding could silently overwrite a
// previous archive's history. This is deliberately NOT caught anywhere — an
// administrator needs to look at the database by hand (rename or remove the
// stale *_legacy_pre_maze tables once their contents are no longer needed,
// or investigate why migration appears to have run twice) rather than the
// app guessing at a resolution and getting it wrong.
export class UnsafeMigrationError extends Error {}

// Archives the pre-maze tables by renaming them rather than dropping them —
// every historical round, vote, and character position/level survives,
// queryable under its *_legacy_pre_maze name, even though the live app can no
// longer act on it (the old action vocabulary and 1D position don't mean
// anything in a 2D maze). This runs inside one transaction: either the full
// archive-and-recreate happens, or none of it does, so a crash mid-migration
// can never leave the database in a half-renamed state.
function migrateToMazeSchema(db: Database.Database): void {
  const sourceTables = ["character", "rounds", "votes"];
  const missingSources = sourceTables.filter((name) => !tableExists(db, name));
  if (missingSources.length > 0) {
    throw new UnsafeMigrationError(
      `cannot archive pre-maze tables: expected character, rounds, and votes to all ` +
        `exist together, but ${missingSources.join(", ")} ${missingSources.length === 1 ? "is" : "are"} missing — ` +
        "this database is in an unexpected partial state. Refusing to guess; inspect " +
        "the database by hand before retrying.",
    );
  }

  const legacyTables = sourceTables.map((name) => `${name}${LEGACY_SUFFIX}`);
  const collisions = legacyTables.filter((name) => tableExists(db, name));
  if (collisions.length > 0) {
    throw new UnsafeMigrationError(
      `cannot archive pre-maze tables: ${collisions.join(", ")} already exist — ` +
        "a previous migration may have already archived this data, or the archive " +
        "tables were created some other way. Refusing to overwrite them; inspect " +
        "the database by hand before retrying.",
    );
  }

  const archive = db.transaction(() => {
    // Order doesn't matter for the rename itself — SQLite updates `votes`'s
    // own FK reference to `rounds` automatically when `rounds` is renamed —
    // but renaming child-to-parent reads naturally in review.
    db.exec(`ALTER TABLE votes RENAME TO votes${LEGACY_SUFFIX}`);
    db.exec(`ALTER TABLE rounds RENAME TO rounds${LEGACY_SUFFIX}`);
    db.exec(`ALTER TABLE character RENAME TO character${LEGACY_SUFFIX}`);
  });
  archive();

  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      event: "db.archived_pre_maze_schema",
      note:
        "pre-maze character/rounds/votes tables renamed to *_legacy_pre_maze and preserved; " +
        "a fresh maze-shaped character/rounds/votes is created alongside them. No prior " +
        "history was deleted.",
      archivedTables: legacyTables,
    }),
  );
}

// Milestone 2: a database that already has the maze shape (character.x/y/won)
// but predates the ten-level expansion (no character.level column) needs an
// *additive* migration, not an archive-by-rename — unlike the position/level
// -> x/y/won change, adding level/score needs no incompatible CHECK rewrite,
// so ALTER TABLE ADD COLUMN is sufficient and keeps every existing row in
// place under its original name (see the migrateToLevelsSchema comment below
// for the one field whose *meaning*, not shape, actually changes: won).
function needsLevelsMigration(db: Database.Database): boolean {
  if (!tableExists(db, "character")) return false;
  const columns = db.prepare("PRAGMA table_info('character')").all() as { name: string }[];
  const hasMazeShape = columns.some((c) => c.name === "x");
  const hasLevelsShape = columns.some((c) => c.name === "level");
  return hasMazeShape && !hasLevelsShape;
}

// Preserves the exact pre-migration character row (id, x, y, won, updated_at)
// untouched, under this table, before any column is added or any value is
// changed — this is the "recoverable legacy snapshot" the migration
// contract requires, named distinctly from migrateToMazeSchema's own
// *_legacy_pre_maze archive tables (a different migration, a different
// question: that one preserves an incompatible *shape*; this one preserves
// an about-to-become-stale *meaning*).
const LEVELS_SNAPSHOT_TABLE = "character_pre_levels_snapshot";

interface CharacterSnapshotRow {
  id: number;
  x: number;
  y: number;
  won: number;
  updated_at: string;
}

// Additive, non-destructive migration: adds character.level/score via ALTER
// TABLE (every existing character/rounds/votes row stays exactly where it
// is, under its original table name — no renaming, no archiving, unlike
// migrateToMazeSchema), but makes one deliberate, logged *semantic*
// correction: a pre-migration won=1 meant "reached the old single maze's
// EXIT," which is not the same claim as "completed level 10" under the
// ten-level game, so it cannot be carried forward as true without silently
// fabricating a false ten-level victory. The original value survives
// unmodified in LEVELS_SNAPSHOT_TABLE, created and populated *before* either
// ALTER TABLE statement runs, so that table is always queryable to recover
// exactly what the database claimed immediately before this migration ran —
// whether or not won happened to be true for this particular database.
// Everything here runs inside one transaction: any failure (including a
// collision check that runs before the transaction, and anything that goes
// wrong inside it) leaves the database exactly as it was, no snapshot table,
// no added columns, no changed won value — never a half-migrated state.
function migrateToLevelsSchema(db: Database.Database): void {
  if (tableExists(db, LEVELS_SNAPSHOT_TABLE)) {
    throw new UnsafeMigrationError(
      `cannot snapshot the pre-levels character row: ${LEVELS_SNAPSHOT_TABLE} already exists — ` +
        "a previous migration may have already run, or this table was created some other way. " +
        "Refusing to overwrite it; inspect the database by hand before retrying.",
    );
  }

  let preMigrationWon = false;

  const migrate = db.transaction(() => {
    const before = db.prepare("SELECT id, x, y, won, updated_at FROM character WHERE id = 1").get() as
      | CharacterSnapshotRow
      | undefined;
    if (!before) {
      throw new UnsafeMigrationError(
        "cannot migrate to the ten-level schema: the character table exists but its row (id = 1) is " +
          "missing — this database is in an unexpected partial state. Refusing to guess; inspect the " +
          "database by hand before retrying.",
      );
    }

    db.exec(`
      CREATE TABLE ${LEVELS_SNAPSHOT_TABLE} (
        id INTEGER PRIMARY KEY,
        x INTEGER NOT NULL,
        y INTEGER NOT NULL,
        won INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        snapshotted_at TEXT NOT NULL
      )
    `);
    db.prepare(
      `INSERT INTO ${LEVELS_SNAPSHOT_TABLE} (id, x, y, won, updated_at, snapshotted_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(before.id, before.x, before.y, before.won, before.updated_at, new Date().toISOString());

    db.exec("ALTER TABLE character ADD COLUMN level INTEGER NOT NULL DEFAULT 1 CHECK (level BETWEEN 1 AND 10)");
    db.exec("ALTER TABLE character ADD COLUMN score INTEGER NOT NULL DEFAULT 0 CHECK (score >= 0)");

    if (before.won === 1) {
      // The only live-row value this migration changes. x, y, and
      // updated_at are left exactly as they were — there is no reason to
      // relocate a character whose position is still a perfectly valid
      // level-1 position (level 1 is byte-identical to the pre-expansion
      // maze); only the claim "the game is won" needed correcting.
      db.prepare("UPDATE character SET won = 0 WHERE id = 1").run();
      preMigrationWon = true;
    }
  });
  migrate();

  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      event: "db.migrated_to_levels_schema",
      note:
        "added character.level/score via ALTER TABLE; character/rounds/votes rows are all unchanged " +
        "in place (no renaming, no archiving). The exact pre-migration character row is preserved in " +
        `${LEVELS_SNAPSHOT_TABLE}. If that row had won=1, it meant victory in the old single-maze game, ` +
        "not completion of the ten-level game, so the live row's won was explicitly reset to 0 — the " +
        "original value remains readable in the snapshot table.",
      preMigrationWon,
      snapshotTable: LEVELS_SNAPSHOT_TABLE,
    }),
  );
}

// Milestone 6: a database that already has the levels shape
// (character.level/score) but predates the collision/transition-announcement
// columns on rounds needs one more additive migration — same ALTER TABLE ADD
// COLUMN pattern as migrateToLevelsSchema, and simpler still: unlike
// character.won, no existing column's *meaning* changes here, so there is no
// snapshot to take and no semantic correction to make. Every historical
// round row keeps its result_action, tally-derived history, and timestamps
// exactly as they were; collided/advanced_level simply default to 0 (false)
// for rows that predate the columns, which is accurate — those rounds really
// were resolved before this project could detect either condition.
function needsRoundEventsMigration(db: Database.Database): boolean {
  if (!tableExists(db, "rounds")) return false;
  const columns = db.prepare("PRAGMA table_info('rounds')").all() as { name: string }[];
  return !columns.some((c) => c.name === "collided");
}

function migrateToRoundEventsSchema(db: Database.Database): void {
  const migrate = db.transaction(() => {
    db.exec("ALTER TABLE rounds ADD COLUMN collided INTEGER NOT NULL DEFAULT 0 CHECK (collided IN (0, 1))");
    db.exec(
      "ALTER TABLE rounds ADD COLUMN advanced_level INTEGER NOT NULL DEFAULT 0 CHECK (advanced_level IN (0, 1))",
    );
  });
  migrate();

  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      event: "db.migrated_to_round_events_schema",
      note:
        "added rounds.collided/advanced_level via ALTER TABLE; every existing round row is unchanged " +
        "in place (no renaming, no archiving, no snapshot needed — unlike character.won, no existing " +
        "column's meaning changed). Historical rounds default both new flags to false, which is " +
        "accurate: those rounds predate this project's ability to record either condition.",
    }),
  );
}

// Seeds pellet_state and enemies from src/game/levels.ts's fixed spawn data,
// for every level, every time getDb() runs — safe to call unconditionally
// (fresh database, migrated database, or a database that was already fully
// seeded by a prior run) because every insert is INSERT OR IGNORE against
// each table's primary key. On a database that was already seeded, every
// row already exists, so every statement here is a guaranteed no-op: a
// pellet already marked collected stays collected, and an enemy already
// moved by later-milestone logic stays at its current (not its spawn)
// position. This is what "initialize exactly once; repeated startup must
// not reset progress" means in practice — there is no separate "has this
// already been seeded" flag to maintain, because INSERT OR IGNORE makes the
// seeding step itself naturally idempotent.
function ensureLevelState(db: Database.Database): void {
  const insertPellet = db.prepare(
    "INSERT OR IGNORE INTO pellet_state (level, x, y, collected) VALUES (?, ?, ?, 0)",
  );
  const insertEnemy = db.prepare(
    "INSERT OR IGNORE INTO enemies (level, index_in_level, x, y) VALUES (?, ?, ?, ?)",
  );

  const seed = db.transaction(() => {
    for (const def of LEVELS) {
      for (const pellet of def.pelletSpawns) {
        insertPellet.run(def.level, pellet.x, pellet.y);
      }
      def.enemySpawns.forEach((enemy, index) => {
        insertEnemy.run(def.level, index, enemy.x, enemy.y);
      });
    }
  });
  seed();
}

// Lazily opened so importing this module never has a side effect; every
// caller goes through here rather than constructing their own connection.
export function getDb(): Database.Database {
  if (db) return db;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  if (needsMigration(db)) migrateToMazeSchema(db);
  if (needsLevelsMigration(db)) migrateToLevelsSchema(db);
  if (needsRoundEventsMigration(db)) migrateToRoundEventsSchema(db);
  db.exec(SCHEMA);
  ensureCharacter(db);
  ensureLevelState(db);
  return db;
}
