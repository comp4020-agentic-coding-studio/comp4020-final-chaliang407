// character.level and character.score are added by src/db/client.ts's
// additive migration (ALTER TABLE ADD COLUMN) for a database that predates
// them, rather than being part of this CREATE TABLE — see that file for why:
// a freshly-created database still gets them from here (CHECK (level BETWEEN
// 1 AND 10) and CHECK (score >= 0) included below), but an *existing*
// database's ALTER TABLE happens exactly once, outside this string, so its
// own CHECK clauses live there instead of being duplicated in two places.
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS character (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  x INTEGER NOT NULL DEFAULT 1,
  y INTEGER NOT NULL DEFAULT 1,
  won INTEGER NOT NULL DEFAULT 0 CHECK (won IN (0, 1)),
  level INTEGER NOT NULL DEFAULT 1 CHECK (level BETWEEN 1 AND 10),
  score INTEGER NOT NULL DEFAULT 0 CHECK (score >= 0),
  updated_at TEXT NOT NULL
);

-- collided/advanced_level are additive, server-authoritative outcome flags
-- for an already-*resolved* round (never written or readable before
-- resolved_at is set — src/game/lifecycle.ts's resolveRound sets all three
-- together, in the same transaction, the same timing rule result_action
-- already followed). They exist so the frontend can announce "ENEMY HIT" or
-- "LEVEL N UNLOCKED" from a fact the server actually recorded, rather than
-- guessing one from a score delta or a position jump (see Milestone 6's
-- requirement that collision/transition announcements be server-confirmed,
-- not inferred). Both are world-state facts about a closed round, not a
-- vote tally or participation count, so exposing them carries no
-- hidden-vote risk — same reasoning already applied to result_action itself.
CREATE TABLE IF NOT EXISTS rounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  opens_at TEXT NOT NULL,
  resolves_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  result_action TEXT CHECK (result_action IN ('UP', 'DOWN', 'LEFT', 'RIGHT', 'TIE')),
  resolved_at TEXT,
  collided INTEGER NOT NULL DEFAULT 0 CHECK (collided IN (0, 1)),
  advanced_level INTEGER NOT NULL DEFAULT 0 CHECK (advanced_level IN (0, 1))
);

CREATE TABLE IF NOT EXISTS votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id INTEGER NOT NULL REFERENCES rounds(id),
  voter_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('UP', 'DOWN', 'LEFT', 'RIGHT')),
  created_at TEXT NOT NULL,
  UNIQUE (round_id, voter_id)
);

-- One row per pellet per level, seeded once from src/game/levels.ts's fixed
-- pelletSpawns and never re-seeded afterward (src/db/client.ts's
-- ensureLevelState uses INSERT OR IGNORE, the same idempotent pattern
-- ensureCharacter already uses for the character row) — a restart only
-- resets \`collected\`, it never re-inserts rows, so repeated server startup
-- can't undo a pellet a player already picked up.
CREATE TABLE IF NOT EXISTS pellet_state (
  level INTEGER NOT NULL CHECK (level BETWEEN 1 AND 10),
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  collected INTEGER NOT NULL DEFAULT 0 CHECK (collected IN (0, 1)),
  PRIMARY KEY (level, x, y)
);

-- One row per enemy per level, seeded once from src/game/levels.ts's fixed
-- enemySpawns, same idempotent-seeding rule as pellet_state above. x/y are
-- live, server-authoritative current positions (updated as a later
-- milestone's enemy movement logic runs), not the original spawn point —
-- the spawn point itself always stays recoverable from levels.ts, since
-- it's fixed source data, not something this table needs to remember.
CREATE TABLE IF NOT EXISTS enemies (
  level INTEGER NOT NULL CHECK (level BETWEEN 1 AND 10),
  index_in_level INTEGER NOT NULL,
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  PRIMARY KEY (level, index_in_level)
);
`;
