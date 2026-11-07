import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Milestone 2: the additive character.level/score migration, and pellet_state
// / enemies seeding. Same pattern as spec/migration.test.ts (which covers the
// *earlier*, unrelated position/level -> x/y/won migration): build a real
// on-disk database by hand in the exact pre-migration shape, open it through
// the real src/db/client.ts path, and inspect what actually happened — never
// a mock of the migration. Every test gets its own mkdtempSync'd directory
// and is responsible for cleaning it up; none of this ever touches the
// project's own .data/ or .data-dev-qa/ directories.
//
// vi.resetModules() before each dynamic import is required because
// src/db/client.ts holds its connection in a closed-over module-level `db`
// singleton — re-importing it fresh is what lets each test start from "no
// connection opened yet," the way a real process boot does.

function buildPreLevelsDatabase(path: string): void {
  // The exact shape the maze/restart milestones left behind: character has
  // x/y/won (the maze shape) but no level/score column yet.
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE character (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      x INTEGER NOT NULL DEFAULT 1,
      y INTEGER NOT NULL DEFAULT 1,
      won INTEGER NOT NULL DEFAULT 0 CHECK (won IN (0, 1)),
      updated_at TEXT NOT NULL
    );
    CREATE TABLE rounds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      opens_at TEXT NOT NULL,
      resolves_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
      result_action TEXT CHECK (result_action IN ('UP', 'DOWN', 'LEFT', 'RIGHT', 'TIE')),
      resolved_at TEXT
    );
    CREATE TABLE votes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      round_id INTEGER NOT NULL REFERENCES rounds(id),
      voter_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('UP', 'DOWN', 'LEFT', 'RIGHT')),
      created_at TEXT NOT NULL,
      UNIQUE (round_id, voter_id)
    );
  `);
}

function seedHistory(path: string, won: 0 | 1): void {
  const db = new Database(path);
  const now = new Date().toISOString();
  db.prepare("INSERT INTO character (id, x, y, won, updated_at) VALUES (1, 7, 7, ?, ?)").run(won, now);
  db.prepare(
    "INSERT INTO rounds (id, opens_at, resolves_at, status, result_action, resolved_at) VALUES (1, ?, ?, 'resolved', 'RIGHT', ?)",
  ).run(now, now, now);
  db.prepare(
    "INSERT INTO rounds (id, opens_at, resolves_at, status, result_action, resolved_at) VALUES (2, ?, ?, 'resolved', 'TIE', ?)",
  ).run(now, now, now);
  db.prepare(
    "INSERT INTO votes (round_id, voter_id, action, created_at) VALUES (1, 'voter-pre-levels-1', 'RIGHT', ?)",
  ).run(now);
  db.prepare(
    "INSERT INTO votes (round_id, voter_id, action, created_at) VALUES (2, 'voter-pre-levels-2', 'LEFT', ?)",
  ).run(now);
  db.close();
}

describe("migrating a pre-levels database (additive character.level/score)", () => {
  let dataDir: string | undefined;

  afterEach(() => {
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    dataDir = undefined;
    vi.resetModules();
    delete process.env.DATA_DIR;
  });

  it("initializes a fresh database (no pre-existing file) with the full ten-level schema in one step", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "levels-migration-"));
    process.env.DATA_DIR = dataDir;

    vi.resetModules();
    const { getDb } = await import("../src/db/client.ts");
    const db = getDb();

    const columns = db.prepare("PRAGMA table_info('character')").all() as { name: string }[];
    expect(columns.map((c) => c.name)).toEqual(
      expect.arrayContaining(["id", "x", "y", "won", "level", "score", "updated_at"]),
    );
    const character = db.prepare("SELECT * FROM character WHERE id = 1").get();
    expect(character).toMatchObject({ x: 1, y: 1, won: 0, level: 1, score: 0 });

    const tableNames = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tableNames).toContain("pellet_state");
    expect(tableNames).toContain("enemies");
    // No snapshot table on a fresh database — there was nothing to migrate.
    expect(tableNames).not.toContain("character_pre_levels_snapshot");
  });

  it("additively migrates an existing pre-levels database: ALTER TABLE ADD COLUMN, not rename or recreate", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "levels-migration-"));
    const dbPath = join(dataDir, "game.db");
    buildPreLevelsDatabase(dbPath);
    seedHistory(dbPath, 0);
    process.env.DATA_DIR = dataDir;

    vi.resetModules();
    const { getDb } = await import("../src/db/client.ts");
    const db = getDb();

    const tableNames = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => (r as { name: string }).name);
    // The original tables are still named character/rounds/votes — no
    // *_legacy_pre_maze-style rename happened for this migration.
    expect(tableNames).toContain("character");
    expect(tableNames).toContain("rounds");
    expect(tableNames).toContain("votes");
    expect(tableNames).not.toContain("character_legacy_pre_maze");

    const columns = db.prepare("PRAGMA table_info('character')").all() as { name: string }[];
    expect(columns.map((c) => c.name)).toEqual(
      expect.arrayContaining(["id", "x", "y", "won", "level", "score", "updated_at"]),
    );

    // The pre-existing character row's x/y/updated_at survive untouched; new
    // columns default to level 1, score 0.
    const character = db.prepare("SELECT * FROM character WHERE id = 1").get();
    expect(character).toMatchObject({ x: 7, y: 7, level: 1, score: 0 });
  });

  it("preserves historical rounds and votes exactly, untouched by the character migration", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "levels-migration-"));
    const dbPath = join(dataDir, "game.db");
    buildPreLevelsDatabase(dbPath);
    seedHistory(dbPath, 0);
    process.env.DATA_DIR = dataDir;

    vi.resetModules();
    const { getDb } = await import("../src/db/client.ts");
    const db = getDb();

    const rounds = db.prepare("SELECT * FROM rounds ORDER BY id").all();
    expect(rounds).toHaveLength(2);
    expect(rounds[0]).toMatchObject({ id: 1, status: "resolved", result_action: "RIGHT" });
    expect(rounds[1]).toMatchObject({ id: 2, status: "resolved", result_action: "TIE" });

    const votes = db.prepare("SELECT * FROM votes ORDER BY id").all();
    expect(votes).toHaveLength(2);
    expect(votes[0]).toMatchObject({ round_id: 1, voter_id: "voter-pre-levels-1", action: "RIGHT" });
    expect(votes[1]).toMatchObject({ round_id: 2, voter_id: "voter-pre-levels-2", action: "LEFT" });
  });

  it("preserves a pre-migration won=0 character row in the legacy snapshot, unresetting nothing live", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "levels-migration-"));
    const dbPath = join(dataDir, "game.db");
    buildPreLevelsDatabase(dbPath);
    seedHistory(dbPath, 0);
    process.env.DATA_DIR = dataDir;

    vi.resetModules();
    const { getDb } = await import("../src/db/client.ts");
    const db = getDb();

    const snapshot = db.prepare("SELECT * FROM character_pre_levels_snapshot WHERE id = 1").get();
    expect(snapshot).toMatchObject({ id: 1, x: 7, y: 7, won: 0 });

    const live = db.prepare("SELECT * FROM character WHERE id = 1").get();
    expect(live).toMatchObject({ won: 0 }); // nothing to correct; was already false
  });

  it(
    "preserves a pre-migration won=1 character row in the legacy snapshot, and explicitly resets the live won to false " +
      "(old victory meant 'reached the single maze's EXIT,' not 'completed level 10')",
    async () => {
      dataDir = mkdtempSync(join(tmpdir(), "levels-migration-"));
      const dbPath = join(dataDir, "game.db");
      buildPreLevelsDatabase(dbPath);
      seedHistory(dbPath, 1);
      process.env.DATA_DIR = dataDir;

      vi.resetModules();
      const { getDb } = await import("../src/db/client.ts");
      const db = getDb();

      // The original won=1 claim is preserved, verbatim, and queryable —
      // "do not silently discard or overwrite" means it must still be
      // readable somewhere, even though the live row no longer says it.
      const snapshot = db.prepare("SELECT * FROM character_pre_levels_snapshot WHERE id = 1").get();
      expect(snapshot).toMatchObject({ id: 1, x: 7, y: 7, won: 1 });
      expect((snapshot as { snapshotted_at: string }).snapshotted_at).toBeTruthy();

      // The live row is explicitly corrected, not left to silently imply a
      // ten-level victory it never earned.
      const live = db.prepare("SELECT * FROM character WHERE id = 1").get();
      expect(live).toMatchObject({ won: 0, level: 1, score: 0 });
      // Position is left exactly as it was — only the victory claim is wrong,
      // not where the character physically stands.
      expect(live).toMatchObject({ x: 7, y: 7 });
    },
  );

  it("is idempotent: running getDb() again does not re-run the migration or touch the snapshot a second time", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "levels-migration-"));
    const dbPath = join(dataDir, "game.db");
    buildPreLevelsDatabase(dbPath);
    seedHistory(dbPath, 1);
    process.env.DATA_DIR = dataDir;

    vi.resetModules();
    const { getDb: getDbFirst } = await import("../src/db/client.ts");
    getDbFirst();

    // Simulate a second process boot against the same on-disk file: a fresh
    // module instance (the real way getDb()'s singleton gets reset between
    // runs) opening the database that's already been migrated once.
    vi.resetModules();
    const { getDb: getDbSecond } = await import("../src/db/client.ts");
    expect(() => getDbSecond()).not.toThrow();

    const check = new Database(dbPath);
    const snapshotRows = check.prepare("SELECT * FROM character_pre_levels_snapshot").all();
    expect(snapshotRows).toHaveLength(1); // still exactly one snapshot row, not duplicated
    check.close();
  });

  it(
    "repeated startup does not reset already-collected pellets or move enemies back to spawn " +
      "(pellet_state/enemies seeding is INSERT OR IGNORE, a true no-op once rows exist)",
    async () => {
      dataDir = mkdtempSync(join(tmpdir(), "levels-migration-"));
      process.env.DATA_DIR = dataDir;

      vi.resetModules();
      const { getDb: getDbFirst } = await import("../src/db/client.ts");
      const dbFirst = getDbFirst();

      // Simulate real gameplay progress: a pellet collected, an enemy moved
      // away from its spawn.
      dbFirst.prepare("UPDATE pellet_state SET collected = 1 WHERE level = 1 AND x = 2 AND y = 1").run();
      dbFirst.prepare("UPDATE enemies SET x = 5, y = 5 WHERE level = 3 AND index_in_level = 0").run();

      // A second "process boot" against the same file.
      vi.resetModules();
      const { getDb: getDbSecond } = await import("../src/db/client.ts");
      const dbSecond = getDbSecond();

      const pellet = dbSecond
        .prepare("SELECT collected FROM pellet_state WHERE level = 1 AND x = 2 AND y = 1")
        .get() as { collected: number };
      expect(pellet.collected).toBe(1); // still collected, not reset to 0

      const enemy = dbSecond
        .prepare("SELECT x, y FROM enemies WHERE level = 3 AND index_in_level = 0")
        .get() as { x: number; y: number };
      expect(enemy).toEqual({ x: 5, y: 5 }); // still at its moved position, not reset to spawn
    },
  );

  it("fails with a clear diagnostic and rolls back entirely if the snapshot slot is already occupied", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "levels-migration-"));
    const dbPath = join(dataDir, "game.db");
    buildPreLevelsDatabase(dbPath);
    seedHistory(dbPath, 1);

    // Simulate "this migration already ran once, and something strange
    // created the snapshot table again" by pre-creating it before getDb()
    // ever runs.
    const raw = new Database(dbPath);
    raw.exec(
      "CREATE TABLE character_pre_levels_snapshot (id INTEGER PRIMARY KEY, x INTEGER, y INTEGER, won INTEGER, updated_at TEXT, snapshotted_at TEXT)",
    );
    raw.close();

    process.env.DATA_DIR = dataDir;
    vi.resetModules();
    const { getDb, UnsafeMigrationError } = await import("../src/db/client.ts");

    expect(() => getDb()).toThrow(UnsafeMigrationError);

    // Nothing was touched: no level/score columns were added, won is still
    // 1 exactly as it was, and no second snapshot row exists.
    const check = new Database(dbPath);
    const columns = check.prepare("PRAGMA table_info('character')").all() as { name: string }[];
    expect(columns.map((c) => c.name)).not.toContain("level");
    expect(columns.map((c) => c.name)).not.toContain("score");
    const character = check.prepare("SELECT * FROM character WHERE id = 1").get();
    expect(character).toMatchObject({ won: 1 });
    const snapshotRows = check.prepare("SELECT * FROM character_pre_levels_snapshot").all();
    expect(snapshotRows).toHaveLength(0); // the pre-created table is still empty — untouched
    check.close();
  });

  it("rolls back the entire transaction (no added columns, no snapshot row) if the character row is missing", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "levels-migration-"));
    const dbPath = join(dataDir, "game.db");
    buildPreLevelsDatabase(dbPath);
    // Deliberately do not seed a character row — an unexpected partial state
    // the migration should refuse to guess its way through.
    const raw = new Database(dbPath);
    raw.exec("DELETE FROM character");
    raw.close();

    process.env.DATA_DIR = dataDir;
    vi.resetModules();
    const { getDb, UnsafeMigrationError } = await import("../src/db/client.ts");

    expect(() => getDb()).toThrow(UnsafeMigrationError);

    const check = new Database(dbPath);
    const columns = check.prepare("PRAGMA table_info('character')").all() as { name: string }[];
    expect(columns.map((c) => c.name)).not.toContain("level"); // ALTER TABLE never committed
    const tableNames = check
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tableNames).not.toContain("character_pre_levels_snapshot"); // CREATE TABLE rolled back too
    check.close();
  });

  it("performs no destructive schema operation anywhere in the migration (no DROP TABLE, no RENAME)", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "levels-migration-"));
    const dbPath = join(dataDir, "game.db");
    buildPreLevelsDatabase(dbPath);
    seedHistory(dbPath, 1);
    process.env.DATA_DIR = dataDir;

    vi.resetModules();
    const { getDb } = await import("../src/db/client.ts");
    const db = getDb();

    // Every table that existed before migration still exists, under its
    // original name, after it.
    const tableNames = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => (r as { name: string }).name);
    for (const original of ["character", "rounds", "votes"]) {
      expect(tableNames).toContain(original);
    }
    // And the new tables this migration adds are additions, not replacements
    // of anything that existed before.
    expect(tableNames).toContain("pellet_state");
    expect(tableNames).toContain("enemies");
    expect(tableNames).toContain("character_pre_levels_snapshot");
  });
});

describe("pellet and enemy seeding", () => {
  let dataDir: string | undefined;

  afterEach(() => {
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    dataDir = undefined;
    vi.resetModules();
    delete process.env.DATA_DIR;
  });

  it("seeds pellet_state and enemies for every level, matching src/game/levels.ts's fixed spawn data exactly", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "levels-migration-"));
    process.env.DATA_DIR = dataDir;

    vi.resetModules();
    const { getDb } = await import("../src/db/client.ts");
    const { LEVELS } = await import("../src/game/levels.ts");
    const db = getDb();

    for (const def of LEVELS) {
      const pellets = db
        .prepare("SELECT x, y, collected FROM pellet_state WHERE level = ? ORDER BY x, y")
        .all(def.level) as { x: number; y: number; collected: number }[];
      expect(pellets).toHaveLength(def.pelletSpawns.length);
      for (const p of pellets) {
        expect(p.collected).toBe(0); // freshly seeded, nothing collected yet
      }
      const expectedPelletKeys = [...def.pelletSpawns].map((p) => `${p.x},${p.y}`).sort();
      const actualPelletKeys = pellets.map((p) => `${p.x},${p.y}`).sort();
      expect(actualPelletKeys).toEqual(expectedPelletKeys);

      const enemies = db
        .prepare("SELECT index_in_level, x, y FROM enemies WHERE level = ? ORDER BY index_in_level")
        .all(def.level) as { index_in_level: number; x: number; y: number }[];
      expect(enemies).toHaveLength(def.enemySpawns.length);
      enemies.forEach((e, i) => {
        expect(e.index_in_level).toBe(i);
        expect(e).toMatchObject({ x: def.enemySpawns[i].x, y: def.enemySpawns[i].y });
      });
    }
  });

  it("seeds every pellet and enemy on a walkable tile, never on that level's START or EXIT", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "levels-migration-"));
    process.env.DATA_DIR = dataDir;

    vi.resetModules();
    const { getDb } = await import("../src/db/client.ts");
    const { LEVELS } = await import("../src/game/levels.ts");
    const db = getDb();

    for (const def of LEVELS) {
      const pellets = db.prepare("SELECT x, y FROM pellet_state WHERE level = ?").all(def.level) as {
        x: number;
        y: number;
      }[];
      const enemies = db.prepare("SELECT x, y FROM enemies WHERE level = ?").all(def.level) as {
        x: number;
        y: number;
      }[];

      for (const spawn of [...pellets, ...enemies]) {
        expect(def.maze.rows[spawn.y]?.[spawn.x]).toBe(".");
        expect(spawn).not.toEqual(def.maze.start);
        expect(spawn).not.toEqual(def.maze.exit);
      }
    }
  });

  it("matches the approved enemy-count schedule (0,0,1,1,2,2,3,3,4,4) once seeded into the database", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "levels-migration-"));
    process.env.DATA_DIR = dataDir;

    vi.resetModules();
    const { getDb } = await import("../src/db/client.ts");
    const db = getDb();

    const counts = db
      .prepare("SELECT level, COUNT(*) as n FROM enemies GROUP BY level ORDER BY level")
      .all() as { level: number; n: number }[];
    const byLevel = new Map(counts.map((c) => [c.level, c.n]));
    const expected = [0, 0, 1, 1, 2, 2, 3, 3, 4, 4];
    for (let level = 1; level <= 10; level++) {
      expect(byLevel.get(level) ?? 0, `level ${level} enemy count`).toBe(expected[level - 1]);
    }
  });
});
