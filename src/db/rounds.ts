import type Database from "better-sqlite3";
import { ROUND_DURATION_MS } from "../config.ts";

export type RoundStatus = "open" | "resolved";
export type RoundResult = "LEFT" | "JUMP" | "RIGHT" | "TIE";

export interface Round {
  id: number;
  opens_at: string;
  resolves_at: string;
  status: RoundStatus;
  result_action: RoundResult | null;
  resolved_at: string | null;
}

// Opens a new round starting now. Resolving an elapsed round is a later
// iteration's job (lazy resolution on read/write, not a timer).
export function createRound(db: Database.Database, durationMs: number = ROUND_DURATION_MS): Round {
  const opensAt = new Date();
  const resolvesAt = new Date(opensAt.getTime() + durationMs);
  const { lastInsertRowid } = db
    .prepare("INSERT INTO rounds (opens_at, resolves_at) VALUES (?, ?)")
    .run(opensAt.toISOString(), resolvesAt.toISOString());
  return getRound(db, Number(lastInsertRowid))!;
}

export function getRound(db: Database.Database, id: number): Round | undefined {
  return db.prepare("SELECT * FROM rounds WHERE id = ?").get(id) as Round | undefined;
}

export function getOpenRound(db: Database.Database): Round | undefined {
  return db
    .prepare("SELECT * FROM rounds WHERE status = 'open' ORDER BY id DESC LIMIT 1")
    .get() as Round | undefined;
}
