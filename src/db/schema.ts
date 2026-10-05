export const SCHEMA = `
CREATE TABLE IF NOT EXISTS character (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  position INTEGER NOT NULL DEFAULT 0,
  -- a discrete vertical/level slot, separate from horizontal position: LEFT
  -- and RIGHT move position, and this is where JUMP's eventual effect will
  -- live, without needing a schema change when that's built
  level INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  opens_at TEXT NOT NULL,
  resolves_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  result_action TEXT CHECK (result_action IN ('LEFT', 'JUMP', 'RIGHT', 'TIE')),
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id INTEGER NOT NULL REFERENCES rounds(id),
  voter_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('LEFT', 'JUMP', 'RIGHT')),
  created_at TEXT NOT NULL,
  UNIQUE (round_id, voter_id)
);
`;
