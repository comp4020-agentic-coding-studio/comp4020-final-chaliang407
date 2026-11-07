import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Milestone 6: the additive rounds.collided/advanced_level migration — the
// server-authoritative mechanism the frontend uses to announce a confirmed
// collision or level transition without ever guessing one from a score
// delta or position jump. Same pattern as spec/levelsMigration.test.ts (the
// earlier, unrelated character.level/score migration): build a real on-disk
// database in the exact pre-migration shape, open it through the real
// src/db/client.ts path, and inspect what actually happened.

function buildPreRoundEventsDatabase(path: string): void {
  // The exact shape every prior milestone left behind: character has
  // level/score (the Milestone 2 shape), but rounds predates
  // collided/advanced_level.
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE character (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      x INTEGER NOT NULL DEFAULT 1,
      y INTEGER NOT NULL DEFAULT 1,
      won INTEGER NOT NULL DEFAULT 0 CHECK (won IN (0, 1)),
      level INTEGER NOT NULL DEFAULT 1 CHECK (level BETWEEN 1 AND 10),
      score INTEGER NOT NULL DEFAULT 0 CHECK (score >= 0),
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
    CREATE TABLE pellet_state (
      level INTEGER NOT NULL CHECK (level BETWEEN 1 AND 10),
      x INTEGER NOT NULL,
      y INTEGER NOT NULL,
      collected INTEGER NOT NULL DEFAULT 0 CHECK (collected IN (0, 1)),
      PRIMARY KEY (level, x, y)
    );
    CREATE TABLE enemies (
      level INTEGER NOT NULL CHECK (level BETWEEN 1 AND 10),
      index_in_level INTEGER NOT NULL,
      x INTEGER NOT NULL,
      y INTEGER NOT NULL,
      PRIMARY KEY (level, index_in_level)
    );
  `);
  const now = new Date().toISOString();
  db.prepare("INSERT INTO character (id, x, y, won, level, score, updated_at) VALUES (1, 5, 5, 0, 3, 40, ?)").run(
    now,
  );
  db.prepare(
    "INSERT INTO rounds (id, opens_at, resolves_at, status, result_action, resolved_at) VALUES (1, ?, ?, 'resolved', 'RIGHT', ?)",
  ).run(now, now, now);
  db.prepare(
    "INSERT INTO votes (round_id, voter_id, action, created_at) VALUES (1, 'voter-pre-round-events-1', 'RIGHT', ?)",
  ).run(now);
  db.close();
}

describe("migrating a pre-round-events database (additive rounds.collided/advanced_level)", () => {
  let dataDir: string | undefined;

  afterEach(() => {
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    dataDir = undefined;
    vi.resetModules();
    delete process.env.DATA_DIR;
  });

  it("initializes a fresh database with collided/advanced_level present from the start", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "round-events-migration-"));
    process.env.DATA_DIR = dataDir;

    vi.resetModules();
    const { getDb } = await import("../src/db/client.ts");
    const db = getDb();

    const columns = db.prepare("PRAGMA table_info('rounds')").all() as { name: string }[];
    expect(columns.map((c) => c.name)).toEqual(expect.arrayContaining(["collided", "advanced_level"]));
  });

  it("additively migrates an existing pre-round-events database: ALTER TABLE ADD COLUMN, not rename or recreate", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "round-events-migration-"));
    const dbPath = join(dataDir, "game.db");
    buildPreRoundEventsDatabase(dbPath);
    process.env.DATA_DIR = dataDir;

    vi.resetModules();
    const { getDb } = await import("../src/db/client.ts");
    const db = getDb();

    const tableNames = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tableNames).toContain("rounds"); // original table, not renamed

    const columns = db.prepare("PRAGMA table_info('rounds')").all() as { name: string }[];
    expect(columns.map((c) => c.name)).toEqual(expect.arrayContaining(["collided", "advanced_level"]));
  });

  it("defaults historical rounds' collided/advanced_level to false, accurately (those rounds predate the ability to record either)", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "round-events-migration-"));
    const dbPath = join(dataDir, "game.db");
    buildPreRoundEventsDatabase(dbPath);
    process.env.DATA_DIR = dataDir;

    vi.resetModules();
    const { getDb } = await import("../src/db/client.ts");
    const db = getDb();

    const round = db.prepare("SELECT * FROM rounds WHERE id = 1").get() as {
      collided: number;
      advanced_level: number;
      result_action: string;
    };
    expect(round.collided).toBe(0);
    expect(round.advanced_level).toBe(0);
    expect(round.result_action).toBe("RIGHT"); // untouched — the migration never rewrites existing columns
  });

  it("preserves historical rounds and votes exactly, untouched by this migration", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "round-events-migration-"));
    const dbPath = join(dataDir, "game.db");
    buildPreRoundEventsDatabase(dbPath);
    process.env.DATA_DIR = dataDir;

    vi.resetModules();
    const { getDb } = await import("../src/db/client.ts");
    const db = getDb();

    const rounds = db.prepare("SELECT * FROM rounds").all();
    expect(rounds).toHaveLength(1);
    const votes = db.prepare("SELECT * FROM votes").all();
    expect(votes).toHaveLength(1);
    expect((votes[0] as { voter_id: string }).voter_id).toBe("voter-pre-round-events-1");

    // The character row — including level/score from the earlier milestone's
    // own migration — is also completely untouched by this one.
    const character = db.prepare("SELECT * FROM character WHERE id = 1").get();
    expect(character).toMatchObject({ x: 5, y: 5, level: 3, score: 40 });
  });

  it("is idempotent: running getDb() again does not re-run the migration or error", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "round-events-migration-"));
    const dbPath = join(dataDir, "game.db");
    buildPreRoundEventsDatabase(dbPath);
    process.env.DATA_DIR = dataDir;

    vi.resetModules();
    const { getDb: getDbFirst } = await import("../src/db/client.ts");
    getDbFirst();

    vi.resetModules();
    const { getDb: getDbSecond } = await import("../src/db/client.ts");
    expect(() => getDbSecond()).not.toThrow();

    const check = new Database(dbPath);
    const columns = check.prepare("PRAGMA table_info('rounds')").all() as { name: string }[];
    // Exactly one collided/advanced_level pair, not duplicated or errored on
    // the second ALTER TABLE attempt (needsRoundEventsMigration correctly
    // reports false once the columns already exist).
    expect(columns.filter((c) => c.name === "collided")).toHaveLength(1);
    expect(columns.filter((c) => c.name === "advanced_level")).toHaveLength(1);
    check.close();
  });

  it("performs no destructive schema operation anywhere in this migration (no DROP TABLE, no RENAME)", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "round-events-migration-"));
    const dbPath = join(dataDir, "game.db");
    buildPreRoundEventsDatabase(dbPath);
    process.env.DATA_DIR = dataDir;

    vi.resetModules();
    const { getDb } = await import("../src/db/client.ts");
    const db = getDb();

    const tableNames = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => (r as { name: string }).name);
    for (const original of ["character", "rounds", "votes", "pellet_state", "enemies"]) {
      expect(tableNames).toContain(original);
    }
  });
});
