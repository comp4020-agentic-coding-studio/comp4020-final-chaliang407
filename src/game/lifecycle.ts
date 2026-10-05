import type Database from "better-sqlite3";
import { createRound, getOpenRound, getRecentResolvedRounds, type Round, type RoundResult } from "../db/rounds.ts";
import { recordVote, tallyVotes, type VoteAction } from "../db/votes.ts";
import { applyRoundResult } from "../db/character.ts";

const ACTIONS: readonly VoteAction[] = ["LEFT", "JUMP", "RIGHT"];

export class InvalidActionError extends Error {
  constructor(action: unknown) {
    super(`invalid action: ${JSON.stringify(action)}`);
    this.name = "InvalidActionError";
  }
}

function decideResult(tally: Record<VoteAction, number>): RoundResult {
  const max = Math.max(...ACTIONS.map((a) => tally[a]));
  const winners = ACTIONS.filter((a) => tally[a] === max);
  // A unique highest count wins; any tie for the highest count — including
  // the all-zero case of an empty round — means no movement.
  return winners.length === 1 ? winners[0] : "TIE";
}

function isDue(round: Round): boolean {
  return new Date(round.resolves_at).getTime() <= Date.now();
}

// Resolves one round and opens the next, inside a single DB transaction. The
// `AND status = 'open'` guard makes the resolving UPDATE a no-op if the round
// was already resolved by the time this runs — belt-and-braces: better-sqlite3
// is synchronous and Node is single-threaded, so two requests in this one
// process can't actually interleave mid-resolution, but the guard keeps this
// correct under a future multi-process deployment too, and costs nothing here.
function resolveRound(db: Database.Database, round: Round): Round {
  const txn = db.transaction((r: Round): Round => {
    const claimed = db
      .prepare("UPDATE rounds SET status = 'resolved' WHERE id = ? AND status = 'open'")
      .run(r.id);
    if (claimed.changes === 0) {
      return getOpenRound(db) ?? createRound(db);
    }

    const tally = tallyVotes(db, r.id);
    const result = decideResult(tally);
    db.prepare("UPDATE rounds SET result_action = ?, resolved_at = ? WHERE id = ?").run(
      result,
      new Date().toISOString(),
      r.id,
    );
    applyRoundResult(db, result);
    return createRound(db);
  });
  return txn(round);
}

// Ensures an open round exists and that it's actually still within its
// window, resolving and rolling forward as needed instead of relying on a
// timer (the Fly machine this runs on can be stopped between requests, so a
// timer would just be lost). In practice this loops at most once: a freshly
// created round's window starts from "now", so it can't already be due.
export function ensureCurrentRound(db: Database.Database): Round {
  let round = getOpenRound(db) ?? createRound(db);
  while (isDue(round)) {
    round = resolveRound(db, round);
  }
  return round;
}

export function castVote(db: Database.Database, voterId: string, action: unknown): { round: Round } {
  const round = ensureCurrentRound(db);
  if (typeof action !== "string" || !ACTIONS.includes(action as VoteAction)) {
    throw new InvalidActionError(action);
  }
  recordVote(db, round.id, voterId, action as VoteAction);
  return { round };
}

export interface ResolvedRoundTrace {
  id: number;
  opensAt: string;
  resolvesAt: string;
  resolvedAt: string;
  result: RoundResult;
  tally: Record<VoteAction, number>;
}

// Resolved rounds may reveal their tally; only the open round is hidden.
export function getRecentTrace(db: Database.Database, limit: number): ResolvedRoundTrace[] {
  return getRecentResolvedRounds(db, limit).map((round) => ({
    id: round.id,
    opensAt: round.opens_at,
    resolvesAt: round.resolves_at,
    resolvedAt: round.resolved_at!,
    result: round.result_action!,
    tally: tallyVotes(db, round.id),
  }));
}
