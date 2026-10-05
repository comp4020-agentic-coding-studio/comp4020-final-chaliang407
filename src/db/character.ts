import type Database from "better-sqlite3";
import type { RoundResult } from "./rounds.ts";

export interface Character {
  id: 1;
  position: number;
  level: number;
  updated_at: string;
}

// getDb() guarantees row id=1 exists, so a missing row means it wasn't
// opened through getDb() — surface that loudly rather than returning undefined.
export function getCharacter(db: Database.Database): Character {
  const row = db.prepare("SELECT * FROM character WHERE id = 1").get() as Character | undefined;
  if (!row) throw new Error("character row missing — was the db opened via getDb()?");
  return row;
}

// LEFT/RIGHT move `position` one discrete step. JUMP flips `level` between
// its two existing discrete values (0/1, "ground"/"elevated") — a real,
// persisted effect, not a no-op, using the column that was reserved for this
// rather than needing a schema change. It's deliberately a plain toggle, not
// a physics simulation; a later crit can widen `level`'s range or meaning
// without touching the schema again. TIE leaves the character untouched.
export function applyRoundResult(db: Database.Database, result: RoundResult): Character {
  const now = new Date().toISOString();
  if (result === "LEFT") {
    db.prepare("UPDATE character SET position = position - 1, updated_at = ? WHERE id = 1").run(now);
  } else if (result === "RIGHT") {
    db.prepare("UPDATE character SET position = position + 1, updated_at = ? WHERE id = 1").run(now);
  } else if (result === "JUMP") {
    db.prepare("UPDATE character SET level = 1 - level, updated_at = ? WHERE id = 1").run(now);
  }
  return getCharacter(db);
}
