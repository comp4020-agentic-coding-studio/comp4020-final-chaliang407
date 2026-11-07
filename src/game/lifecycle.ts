import type Database from "better-sqlite3";
import { createRound, getOpenRound, getRecentResolvedRounds, type Round, type RoundResult } from "../db/rounds.ts";
import { recordVote, tallyVotes, type VoteAction } from "../db/votes.ts";
import { applyRoundResult, applyRoundResultDetailed, getCharacter, resetCharacter } from "../db/character.ts";
import { resetAllPellets } from "../db/pellets.ts";
import { resetAllEnemiesToSpawn } from "../db/enemies.ts";
import { logGameRestarted, logRoundResolved } from "../logging.ts";

const ACTIONS: readonly VoteAction[] = ["UP", "DOWN", "LEFT", "RIGHT"];

export class InvalidActionError extends Error {
  readonly roundId: number;

  constructor(action: unknown, roundId: number) {
    super(`invalid action: ${JSON.stringify(action)}`);
    this.name = "InvalidActionError";
    this.roundId = roundId;
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
// `didResolve` tells the caller whether *this* call is the one that actually
// performed the resolution, vs. losing the (today-impossible, but guarded
// anyway) race and just rolling a stale round forward — that's what lets
// every caller share one real-time broadcast without double-firing it.
function resolveRound(db: Database.Database, round: Round): { round: Round; didResolve: boolean } {
  let didResolve = false;
  // Captured inside the transaction (so they reflect exactly what committed)
  // but logged after it returns — logging is an external side effect with no
  // place inside a DB transaction that SQLite might retry or roll back.
  let logFields: Parameters<typeof logRoundResolved>[0] | undefined;

  const txn = db.transaction((r: Round): Round => {
    const claimed = db
      .prepare("UPDATE rounds SET status = 'resolved' WHERE id = ? AND status = 'open'")
      .run(r.id);
    if (claimed.changes === 0) {
      return getOpenRound(db) ?? createRound(db);
    }

    const characterBefore = getCharacter(db);
    const tally = tallyVotes(db, r.id);
    const result = decideResult(tally);
    db.prepare("UPDATE rounds SET result_action = ?, resolved_at = ? WHERE id = ?").run(
      result,
      new Date().toISOString(),
      r.id,
    );
    const { character: characterAfter, collided, advancedLevel } = applyRoundResultDetailed(db, result);
    // Written after result_action/resolved_at, in the same transaction, so a
    // round's outcome flags are never readable before the round itself is
    // marked resolved — same timing rule that already applies to
    // result_action and to buildStatePayload's recentRounds tallies.
    db.prepare("UPDATE rounds SET collided = ?, advanced_level = ? WHERE id = ?").run(
      collided ? 1 : 0,
      advancedLevel ? 1 : 0,
      r.id,
    );
    didResolve = true;
    logFields = {
      roundId: r.id,
      result,
      tally,
      characterBefore: {
        x: characterBefore.x,
        y: characterBefore.y,
        won: characterBefore.won,
        score: characterBefore.score,
        level: characterBefore.level,
      },
      characterAfter: {
        x: characterAfter.x,
        y: characterAfter.y,
        won: characterAfter.won,
        score: characterAfter.score,
        level: characterAfter.level,
      },
      collided,
      advancedLevel,
    };
    return createRound(db);
  });
  const next = txn(round);
  // Only after the resolving round's own transaction has committed — the
  // same timing rule buildStatePayload's recentRounds already follows
  // (never reveal a round's tally before it's actually resolved).
  if (logFields) logRoundResolved(logFields);
  return { round: next, didResolve };
}

// Ensures an open round exists and that it's actually still within its
// window, resolving and rolling forward as needed instead of relying on a
// timer (the Fly machine this runs on can be stopped between requests, so a
// timer would just be lost). In practice this loops at most once: a freshly
// created round's window starts from "now", so it can't already be due.
//
// `onResolved` fires once per round actually resolved here. Every path that
// can observe a due round — a vote, a state poll, and the real-time layer's
// proactive deadline timer — routes through this one function, so whichever
// caller happens to be the one that resolves it is the one that notifies.
export function ensureCurrentRound(db: Database.Database, onResolved?: () => void): Round {
  let round = getOpenRound(db) ?? createRound(db);
  while (isDue(round)) {
    const { round: next, didResolve } = resolveRound(db, round);
    if (didResolve) onResolved?.();
    round = next;
  }
  return round;
}

export function castVote(
  db: Database.Database,
  voterId: string,
  action: unknown,
  onResolved?: () => void,
): { round: Round } {
  const round = ensureCurrentRound(db, onResolved);
  if (typeof action !== "string" || !ACTIONS.includes(action as VoteAction)) {
    throw new InvalidActionError(action, round.id);
  }
  recordVote(db, round.id, voterId, action as VoteAction);
  return { round };
}

export class RestartNotAllowedError extends Error {
  constructor() {
    super("restart is only allowed after the character has reached EXIT");
    this.name = "RestartNotAllowedError";
  }
}

// Server-authoritative, atomic restart: any connected player's request can
// trigger it (no special authorization beyond the ordinary anonymous
// identity every endpoint already requires), but it only ever takes effect
// if the character has actually reached EXIT — `character.won` is both the
// permission check and, because it's re-read fresh inside the transaction
// below, the concurrency guard. Node is single-threaded and better-sqlite3's
// transaction() runs synchronously with no interleaving `await` inside it
// (same guarantee resolveRound already relies on), so two concurrent restart
// requests can never both observe `won === true`: whichever's transaction
// commits first flips it back to false, and the second — processed strictly
// after the first completes, never during it — finds `won === false` and is
// rejected by RestartNotAllowedError instead of restarting twice or
// double-creating rounds.
export function restartGame(
  db: Database.Database,
  voterId: string,
  onResolved?: () => void,
): { round: Round } {
  // Guarantees an open round exists before the transaction below reads one —
  // the same invariant castVote and buildStatePayload already depend on.
  ensureCurrentRound(db, onResolved);

  let logFields: { closedRoundId: number; newRoundId: number } | undefined;

  const txn = db.transaction((): Round => {
    const character = getCharacter(db);
    if (!character.won) {
      throw new RestartNotAllowedError();
    }

    const openRound = getOpenRound(db);
    if (openRound) {
      // Closed out exactly like an ordinary resolution — decided from
      // whatever was actually cast against it — rather than invented or
      // discarded, so the historical trace stays uniform. This is
      // guaranteed to be a no-op on the character: `character.won` is still
      // true at this exact point (the reset happens after), and
      // applyRoundResult never moves an already-won character. That's what
      // makes any stale vote or stale timer on this round harmless — it
      // gets to "decide" a result, but that result can never reach the
      // freshly-reset character, because the reset hasn't happened when
      // it's applied, and nothing resolves this round again afterward.
      const claimed = db
        .prepare("UPDATE rounds SET status = 'resolved' WHERE id = ? AND status = 'open'")
        .run(openRound.id);
      if (claimed.changes > 0) {
        const tally = tallyVotes(db, openRound.id);
        const result = decideResult(tally);
        db.prepare("UPDATE rounds SET result_action = ?, resolved_at = ? WHERE id = ?").run(
          result,
          new Date().toISOString(),
          openRound.id,
        );
        applyRoundResult(db, result);
        // No corresponding collided/advanced_level write here: this round's
        // own result can never actually collide or advance a level, because
        // applyRoundResult is a guaranteed no-op against an already-won
        // character — the schema's default of 0/false for both columns is
        // already the accurate answer for this round.
      }
    }

    // A full new run: character back to level 1 START with score zeroed,
    // every level's pellets uncollected again, every enemy back at its fixed
    // spawn (src/game/levels.ts) — all three in this same transaction, so a
    // crash partway through can never leave, say, pellets reset but the
    // character still mid-level-7.
    resetCharacter(db);
    resetAllPellets(db);
    resetAllEnemiesToSpawn(db);
    // A brand-new round, timed from *now* — no stale resolves_at carried
    // over from before the restart, so the fresh round gets its own full
    // ROUND_DURATION_MS window rather than inheriting whatever was left on
    // the pre-restart round's clock.
    const fresh = createRound(db);
    logFields = { closedRoundId: openRound?.id ?? fresh.id, newRoundId: fresh.id };
    return fresh;
  });

  const round = txn();
  if (logFields) logGameRestarted(voterId, logFields.closedRoundId, logFields.newRoundId);
  // Every connected client learns about the restart the same way it learns
  // about any other round change — the existing content-free SSE signal,
  // followed by each client's own GET /api/state refetch.
  onResolved?.();
  return { round };
}

export interface ResolvedRoundTrace {
  id: number;
  opensAt: string;
  resolvesAt: string;
  resolvedAt: string;
  result: RoundResult;
  tally: Record<VoteAction, number>;
  // Server-confirmed outcome of this specific resolved round — never
  // inferred client-side from a score delta or a position jump. See
  // src/db/schema.ts's comment on rounds.collided/advanced_level for why
  // exposing these carries no hidden-vote risk.
  collided: boolean;
  advancedLevel: boolean;
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
    collided: round.collided === 1,
    advancedLevel: round.advanced_level === 1,
  }));
}
