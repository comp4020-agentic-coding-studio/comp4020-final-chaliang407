import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA } from "./schema.ts";
import { DB_PATH } from "../config.ts";

let db: Database.Database | undefined;

function ensureCharacter(db: Database.Database): void {
  db.prepare(
    "INSERT OR IGNORE INTO character (id, position, level, updated_at) VALUES (1, 0, 0, ?)",
  ).run(new Date().toISOString());
}

// Lazily opened so importing this module never has a side effect; every
// caller goes through here rather than constructing their own connection.
export function getDb(): Database.Database {
  if (db) return db;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  ensureCharacter(db);
  return db;
}
