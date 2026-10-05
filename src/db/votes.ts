import type Database from "better-sqlite3";
import type { RoundResult } from "./rounds.ts";

export type VoteAction = Exclude<RoundResult, "TIE">;

export interface Vote {
  id: number;
  round_id: number;
  voter_id: string;
  action: VoteAction;
  created_at: string;
}

export class DuplicateVoteError extends Error {
  constructor(roundId: number, voterId: string) {
    super(`voter ${voterId} already voted in round ${roundId}`);
    this.name = "DuplicateVoteError";
  }
}

// One vote per voter per round is enforced by votes.UNIQUE(round_id,
// voter_id) in the schema, not just here; this turns that constraint
// violation into a typed error instead of a raw SqliteError leaking out.
export function recordVote(
  db: Database.Database,
  roundId: number,
  voterId: string,
  action: VoteAction,
): Vote {
  try {
    const { lastInsertRowid } = db
      .prepare("INSERT INTO votes (round_id, voter_id, action, created_at) VALUES (?, ?, ?, ?)")
      .run(roundId, voterId, action, new Date().toISOString());
    return db.prepare("SELECT * FROM votes WHERE id = ?").get(Number(lastInsertRowid)) as Vote;
  } catch (err) {
    if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) {
      throw new DuplicateVoteError(roundId, voterId);
    }
    throw err;
  }
}

export function getVotes(db: Database.Database, roundId: number): Vote[] {
  return db.prepare("SELECT * FROM votes WHERE round_id = ?").all(roundId) as Vote[];
}
