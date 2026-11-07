import { createHmac, randomBytes } from "node:crypto";
import { VOTER_LABEL_SECRET } from "./config.ts";

// A bare voter_id is already opaque, but logging it verbatim would still let
// anyone who can read the logs correlate a player across the log stream with
// the exact bearer value that authenticates their votes. HMAC-ing it under a
// server-only key yields a label that's stable (same voter_id -> same label,
// every time) and one-way (the key never appears in the label, and the label
// can't be inverted back to voter_id without it) — exactly what "who did
// what" in the logs needs, without the logs themselves becoming a second copy
// of the credential.
//
// VOTER_LABEL_SECRET (src/config.ts) is optional. If it's unset, a random key
// is generated once at process startup instead: labels are still stable for
// every request this process handles, which is enough for a single
// uninterrupted demo session, but they change on every restart (including a
// Fly machine stopping and later auto-starting between requests — see
// fly.toml's auto_stop_machines), so the same browser can show a different
// label after a gap. Setting VOTER_LABEL_SECRET (e.g. `flyctl secrets set
// VOTER_LABEL_SECRET=<random value>`) keeps labels stable across restarts and
// deploys too. This is a labelling concern only — it changes nothing about
// who is allowed to vote or what they can see.
const processKey = randomBytes(32);
if (!VOTER_LABEL_SECRET) {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      event: "logging.ephemeral_label_key",
      note: "VOTER_LABEL_SECRET not set; player labels are derived from a random per-process key and will change after a restart. Set VOTER_LABEL_SECRET for labels that stay stable across deploys.",
    }),
  );
}

// Short, fixed-length, non-reversible without the key — safe to print.
export function deriveLabel(voterId: string): string {
  return createHmac("sha256", VOTER_LABEL_SECRET ?? processKey).update(voterId).digest("hex").slice(0, 10);
}

function emit(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
}

// Fires only from the mint branch of getOrCreateVoterId (src/http/voter.ts)
// — never for a request that already carried a voter_id cookie — so this
// event means "a new anonymous identity was created," not "a request arrived
// from a known one."
export function logIdentityCreated(voterId: string): void {
  emit("identity.created", { player: deriveLabel(voterId) });
}

export function logSseConnected(voterId: string, openConnections: number): void {
  emit("sse.connected", { player: deriveLabel(voterId), openConnections });
}

export function logSseDisconnected(voterId: string, openConnections: number): void {
  emit("sse.disconnected", { player: deriveLabel(voterId), openConnections });
}

export function logVoteAccepted(voterId: string, roundId: number, action: string): void {
  emit("vote.accepted", { player: deriveLabel(voterId), round: roundId, action });
}

export type VoteRejectionReason = "duplicate" | "invalid_action" | "payload_too_large" | "malformed_json";

// `voterId` is optional only for defensiveness against a future rejection
// path that fires before an identity can be resolved at all; every rejection
// path today resolves one first, so it's always present in practice.
export function logVoteRejected(voterId: string | undefined, reason: VoteRejectionReason, roundId?: number): void {
  emit("vote.rejected", {
    player: voterId !== undefined ? deriveLabel(voterId) : undefined,
    reason,
    round: roundId,
  });
}

// A safe category for an unexpected internal error: the error's own `name`
// (e.g. "TypeError", "SqliteError", or one of this project's own typed error
// classes) is a fixed, static label set by the code that threw, never by
// request-derived data — unlike `.message` or `.stack`, which can and do
// embed whatever string happened to be in scope (see DuplicateVoteError's old
// voterId-in-message shape in src/db/votes.ts, before this file existed).
// Falls back to "unknown" for a thrown value that isn't even an Error.
function errorCategory(err: unknown): string {
  if (err instanceof Error) return err.name || err.constructor.name || "Error";
  return "unknown";
}

// For the generic catch-alls in src/api.ts and src/server.ts: logs enough to
// debug "something broke in operation X, of kind Y" without ever touching
// `.message` or `.stack`, so a future error type that happens to interpolate
// a voter id, cookie, or request body into its message can't leak it here —
// the one place in this codebase that logs arbitrary caught errors.
export function logInternalError(operation: string, err: unknown): void {
  emit("internal_error", { operation, errorType: errorCategory(err) });
}

export interface RoundResolvedLog {
  roundId: number;
  result: string;
  tally: Record<string, number>;
  characterBefore: { x: number; y: number; won: boolean; score: number; level: number };
  characterAfter: { x: number; y: number; won: boolean; score: number; level: number };
  // Reported explicitly by the caller (src/db/character.ts's
  // applyRoundResultDetailed) rather than re-derived from the before/after
  // character snapshot: a collision's -20 penalty can land on the same
  // round as an unrelated score change from floor-at-zero clamping, and
  // "score decreased" alone can't distinguish a collision from, in
  // principle, any other future score-decreasing event — the caller already
  // knows definitively which happened, so this just carries that fact
  // through rather than guessing at it a second time from the numbers.
  collided: boolean;
  advancedLevel: boolean;
}

// Only ever called after a round's resolving transaction has committed
// (src/game/lifecycle.ts's resolveRound), so — same timing rule as
// buildStatePayload's recentRounds — this never logs a tally for a round
// that's still open. Score, level, and collision outcome are world state,
// not a vote tally, so logging them here carries no hidden-vote risk — same
// reasoning as exposing score/level through buildStatePayload.
export function logRoundResolved(params: RoundResolvedLog): void {
  const moved =
    params.characterBefore.x !== params.characterAfter.x ||
    params.characterBefore.y !== params.characterAfter.y;
  const pelletCollected = !params.collided && params.characterAfter.score > params.characterBefore.score;
  emit("round.resolved", {
    round: params.roundId,
    result: params.result,
    tally: params.tally,
    character: { before: params.characterBefore, after: params.characterAfter },
    moved,
    wonThisRound: !params.characterBefore.won && params.characterAfter.won,
    pelletCollected,
    advancedLevel: params.advancedLevel,
    collided: params.collided,
  });
}

// Fires once per successful restart — named by the player label whose
// request actually performed it (any connected player may initiate a
// restart; this just records which one's request happened to win the race),
// the round it closed out, and the fresh round it opened. Only ever called
// after restartGame's own transaction has committed (src/game/lifecycle.ts),
// same timing rule as round.resolved and buildStatePayload's recentRounds.
export function logGameRestarted(voterId: string, closedRoundId: number, newRoundId: number): void {
  emit("game.restarted", { player: deriveLabel(voterId), closedRound: closedRoundId, newRound: newRoundId });
}
