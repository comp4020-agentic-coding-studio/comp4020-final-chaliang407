import type Database from "better-sqlite3";

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
