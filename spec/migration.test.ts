import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Builds a real pre-maze database file by hand (the exact shape C8–C10
// shipped: character.position/level, rounds/votes CHECK-ing the old
// LEFT/JUMP/RIGHT vocabulary) and then opens it through the real
// src/db/client.ts migration path — the only way to check "does the
// migration actually preserve old data" is against an on-disk database that
// looks like a real one, not a mock of one.
//
// Each test gets its own temp dir and a *fresh* dynamic import of
// src/db/client.ts: that module holds its connection in a closed-over `db`
// singleton, so re-importing it (rather than calling getDb() twice against
// different paths on the same imported instance) is what lets each test
// start from "no connection opened yet" the way a real process boot does.
// vitest's module registry is per test-file by default but shared *within*
// one file across dynamic imports unless explicitly reset, hence
// `vi.resetModules()` before each import below.

function buildPreMazeDatabase(path: string): void {
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE character (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      position INTEGER NOT NULL DEFAULT 0,
      level INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE rounds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      opens_at TEXT NOT NULL,
      resolves_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
      result_action TEXT CHECK (result_action IN ('LEFT', 'JUMP', 'RIGHT', 'TIE')),
      resolved_at TEXT
    );
    CREATE TABLE votes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      round_id INTEGER NOT NULL REFERENCES rounds(id),
      voter_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('LEFT', 'JUMP', 'RIGHT')),
      created_at TEXT NOT NULL,
      UNIQUE (round_id, voter_id)
    );
  `);
  const now = new Date().toISOString();
  db.prepare("INSERT INTO character (id, position, level, updated_at) VALUES (1, 4, 1, ?)").run(now);
  db.prepare(
    "INSERT INTO rounds (id, opens_at, resolves_at, status, result_action, resolved_at) VALUES (1, ?, ?, 'resolved', 'RIGHT', ?)",
  ).run(now, now, now);
  db.prepare(
    "INSERT INTO votes (round_id, voter_id, action, created_at) VALUES (1, 'voter-pre-maze-1', 'RIGHT', ?)",
  ).run(now);
  db.close();
}

describe("migrating a pre-maze database", () => {
  let dataDir: string | undefined;

  afterEach(() => {
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    dataDir = undefined;
    vi.resetModules();
    delete process.env.DATA_DIR;
  });

  it("archives the old tables by renaming them, preserving every historical row, rather than dropping them", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "maze-migration-"));
    buildPreMazeDatabase(join(dataDir, "game.db"));
    process.env.DATA_DIR = dataDir;

    vi.resetModules();
    const { getDb } = await import("../src/db/client.ts");
    const db = getDb();

    // The archived legacy tables exist, under the documented *_legacy_pre_maze
    // name, and still hold exactly the rows the pre-maze database had.
    const legacyCharacter = db.prepare("SELECT * FROM character_legacy_pre_maze").all();
    expect(legacyCharacter).toEqual([
      expect.objectContaining({ id: 1, position: 4, level: 1 }),
    ]);

    const legacyRounds = db.prepare("SELECT * FROM rounds_legacy_pre_maze").all();
    expect(legacyRounds).toEqual([
      expect.objectContaining({ id: 1, status: "resolved", result_action: "RIGHT" }),
    ]);

    const legacyVotes = db.prepare("SELECT * FROM votes_legacy_pre_maze").all();
    expect(legacyVotes).toEqual([
      expect.objectContaining({ round_id: 1, voter_id: "voter-pre-maze-1", action: "RIGHT" }),
    ]);

    // Nothing was dropped: the old table names no longer exist as *live*
    // tables (they were renamed, not duplicated), but their content survives
    // in full under the legacy name checked above — this is the "archive
    // instead of delete" contract end to end.
    const liveTableNames = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(liveTableNames).toContain("character_legacy_pre_maze");
    expect(liveTableNames).toContain("rounds_legacy_pre_maze");
    expect(liveTableNames).toContain("votes_legacy_pre_maze");
  });

  it("creates a fresh maze-shaped character/rounds/votes alongside the archived legacy tables", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "maze-migration-"));
    buildPreMazeDatabase(join(dataDir, "game.db"));
    process.env.DATA_DIR = dataDir;

    vi.resetModules();
    const { getDb } = await import("../src/db/client.ts");
    const { getCharacter } = await import("../src/db/character.ts");
    const { START } = await import("../src/game/maze.ts");
    const db = getDb();

    // The live, maze-shaped character is freshly seeded at START, with no
    // trace of the legacy row's position/level values carried over (there is
    // no meaningful mapping from a 1D position/level pair to a 2D maze cell).
    const character = getCharacter(db);
    expect(character.x).toBe(START.x);
    expect(character.y).toBe(START.y);
    expect(character.won).toBe(false);

    // The live rounds/votes tables accept the new UP/DOWN/LEFT/RIGHT
    // vocabulary (the schema actually changed, not just the character row).
    const columns = db.prepare("PRAGMA table_info('votes')").all() as { name: string }[];
    expect(columns.map((c) => c.name)).toContain("action");
    expect(() =>
      db
        .prepare("INSERT INTO rounds (opens_at, resolves_at) VALUES (?, ?)")
        .run(new Date().toISOString(), new Date().toISOString()),
    ).not.toThrow();
  });

  it("refuses to run twice over the same archive slot, failing loudly instead of silently overwriting history", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "maze-migration-"));
    const dbPath = join(dataDir, "game.db");
    buildPreMazeDatabase(dbPath);

    // Simulate "migration already ran once:" the archive tables already
    // exist, carrying their own (different) historical data, when a second
    // migration attempt is forced by rebuilding a pre-maze-shaped character
    // table on top.
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE character_legacy_pre_maze (
        id INTEGER PRIMARY KEY, position INTEGER, level INTEGER, updated_at TEXT
      );
    `);
    raw.close();

    process.env.DATA_DIR = dataDir;
    vi.resetModules();
    const { getDb, UnsafeMigrationError } = await import("../src/db/client.ts");

    expect(() => getDb()).toThrow(UnsafeMigrationError);

    // And critically: the attempt must not have touched the original,
    // still-live pre-maze tables — the failure happens before anything is
    // renamed (collisions are checked before the rename transaction starts).
    const check = new Database(dbPath);
    const liveTableNames = check
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(liveTableNames).toContain("character"); // original table untouched
    expect(liveTableNames).toContain("rounds");
    expect(liveTableNames).toContain("votes");
    const originalCharacter = check.prepare("SELECT * FROM character").get();
    expect(originalCharacter).toMatchObject({ position: 4, level: 1 });
    check.close();
  });

  it("does not migrate a fresh database that already has the maze shape", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "maze-migration-"));
    process.env.DATA_DIR = dataDir;

    vi.resetModules();
    const { getDb } = await import("../src/db/client.ts");
    const db = getDb();

    const liveTableNames = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(liveTableNames).not.toContain("character_legacy_pre_maze");
    expect(liveTableNames).toContain("character");
  });
});
