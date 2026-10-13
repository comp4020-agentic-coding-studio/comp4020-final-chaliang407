import type { IncomingMessage, ServerResponse } from "node:http";
import type Database from "better-sqlite3";
import { getOrCreateVoterId } from "./http/voter.ts";
import { getCharacter } from "./db/character.ts";
import { hasVoted, DuplicateVoteError } from "./db/votes.ts";
import { ensureCurrentRound, castVote, getRecentTrace, InvalidActionError } from "./game/lifecycle.ts";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

export interface StatePayload {
  character: { position: number; level: number };
  round: {
    id: number;
    opensAt: string;
    resolvesAt: string;
    status: string;
    hasVoted: boolean;
  };
  recentRounds: ReturnType<typeof getRecentTrace>;
}

// The one place the open round's tallies are allowed to be read at all — and
// they never are. Only `hasVoted` for *this* voter crosses the wire for the
// open round; `recentRounds` carries tallies, but only for already-resolved
// rounds. This is the only function that builds a state response, so the
// hidden-vote rule can't drift between callers — there's only one caller.
//
// The SSE layer (src/http/events.ts) never calls this function and carries
// no state of its own: it broadcasts a content-free "a round resolved" event
// with nothing to leak, and it's each browser's own subsequent GET
// /api/state — landing here, same as any other request — that fetches its
// real, per-voter, hidden-tally-respecting state.
//
// `onResolved` is threaded through to `ensureCurrentRound` so that whichever
// request happens to observe a round go overdue — this one included — is the
// one that fires the real-time broadcast, with the lazy resolve-on-read
// behaviour this project depends on left completely unchanged.
export function buildStatePayload(
  db: Database.Database,
  voterId: string,
  onResolved?: () => void,
): StatePayload {
  const round = ensureCurrentRound(db, onResolved);
  const character = getCharacter(db);

  return {
    character: { position: character.position, level: character.level },
    round: {
      id: round.id,
      opensAt: round.opens_at,
      resolvesAt: round.resolves_at,
      status: round.status,
      hasVoted: hasVoted(db, round.id, voterId),
    },
    recentRounds: getRecentTrace(db, 5),
  };
}

export function handleGetState(
  req: IncomingMessage,
  res: ServerResponse,
  db: Database.Database,
  onResolved?: () => void,
): void {
  const voterId = getOrCreateVoterId(req, res);
  sendJson(res, 200, buildStatePayload(db, voterId, onResolved));
}

// The only body this endpoint ever expects is {"action":"LEFT"|"JUMP"|"RIGHT"}
// — a few bytes — so this cap is generous, not tight; it exists to reject
// abusive bodies before they're fully buffered, not to accommodate legitimate
// large input.
const MAX_VOTE_BODY_BYTES = 1024;

class PayloadTooLargeError extends Error {}

async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const declaredLength = Number(req.headers["content-length"] ?? 0);
  if (declaredLength > maxBytes) {
    throw new PayloadTooLargeError();
  }

  let total = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > maxBytes) {
      throw new PayloadTooLargeError();
    }
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw === "" ? {} : JSON.parse(raw);
}

export async function handlePostVote(
  req: IncomingMessage,
  res: ServerResponse,
  db: Database.Database,
  onResolved?: () => void,
): Promise<void> {
  const voterId = getOrCreateVoterId(req, res);

  let body: unknown;
  try {
    body = await readJsonBody(req, MAX_VOTE_BODY_BYTES);
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      // Close the connection once this response is flushed rather than
      // trying to drain whatever's left of an oversized body — simpler, and
      // it can't leave stray bytes to corrupt the next request on a
      // keep-alive connection.
      res.setHeader("connection", "close");
      sendJson(res, 413, { error: "payload too large" });
    } else {
      sendJson(res, 400, { error: "malformed JSON body" });
    }
    return;
  }

  const action = body !== null && typeof body === "object" ? (body as Record<string, unknown>).action : undefined;

  try {
    const { round } = castVote(db, voterId, action, onResolved);
    sendJson(res, 200, {
      round: { id: round.id, opensAt: round.opens_at, resolvesAt: round.resolves_at },
    });
  } catch (err) {
    if (err instanceof InvalidActionError) {
      sendJson(res, 400, { error: "invalid action" });
    } else if (err instanceof DuplicateVoteError) {
      sendJson(res, 409, { error: "already voted this round" });
    } else {
      console.error(err);
      sendJson(res, 500, { error: "internal error" });
    }
  }
}
