import type { IncomingMessage, ServerResponse } from "node:http";
import type Database from "better-sqlite3";
import { getOrCreateVoterId } from "./http/voter.ts";
import { getCharacter } from "./db/character.ts";
import { hasVoted, DuplicateVoteError } from "./db/votes.ts";
import { getPellets } from "./db/pellets.ts";
import { getEnemies } from "./db/enemies.ts";
import {
  ensureCurrentRound,
  castVote,
  getRecentTrace,
  restartGame,
  InvalidActionError,
  RestartNotAllowedError,
} from "./game/lifecycle.ts";
import { getMazeLayout } from "./game/maze.ts";
import { getLevel } from "./game/levels.ts";
import { logInternalError, logVoteAccepted, logVoteRejected } from "./logging.ts";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

// The maze layout is fixed and identical for every request — no DB read, no
// per-voter data — so it's served from its own endpoint once per page load
// rather than folding static geometry into every /api/state poll.
export function handleGetMaze(_req: IncomingMessage, res: ServerResponse): void {
  sendJson(res, 200, getMazeLayout());
}

export interface StatePayload {
  character: { x: number; y: number; won: boolean; level: number; score: number };
  round: {
    id: number;
    opensAt: string;
    resolvesAt: string;
    status: string;
    hasVoted: boolean;
  };
  recentRounds: ReturnType<typeof getRecentTrace>;
  // Every pellet for the character's *current* level, collected or not —
  // world state, always safe to expose in full regardless of round status,
  // exactly like character position already is (see this function's own
  // comment on the hidden-vote rule, which is specifically about vote
  // tallies/participation, not about pellets, enemies, level, or score).
  pellets: { x: number; y: number; collected: boolean }[];
  // Every enemy for the character's *current* level, at its current
  // server-authoritative position — world state, same hidden-vote-rule
  // reasoning as pellets above. The random choice behind each enemy's move
  // is made and persisted entirely server-side (src/db/enemies.ts,
  // src/game/enemies.ts); a client only ever sees the resulting position
  // here, never a seed, a choice, or anything it could simulate itself.
  enemies: { x: number; y: number }[];
  // The maze geometry for the character's *current* level — levels have
  // different grids, so unlike the original single-maze /api/maze endpoint
  // (still served, for the original level-1-only maze, used by
  // spec/maze.test.ts's own checks), the frontend needs the level-aware
  // version here to know which walls/paths to render after a level
  // transition, without a second round-trip or a client-side level->geometry
  // table of its own.
  maze: {
    width: number;
    height: number;
    rows: readonly string[];
    start: { x: number; y: number };
    exit: { x: number; y: number };
  };
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
    character: {
      x: character.x,
      y: character.y,
      won: character.won,
      level: character.level,
      score: character.score,
    },
    round: {
      id: round.id,
      opensAt: round.opens_at,
      resolvesAt: round.resolves_at,
      status: round.status,
      hasVoted: hasVoted(db, round.id, voterId),
    },
    recentRounds: getRecentTrace(db, 5),
    pellets: getPellets(db, character.level).map((p) => ({ x: p.x, y: p.y, collected: p.collected })),
    enemies: getEnemies(db, character.level).map((e) => ({ x: e.x, y: e.y })),
    maze: getLevel(character.level).maze,
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

// The only body this endpoint ever expects is {"action":"UP"|"DOWN"|"LEFT"|"RIGHT"}
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
      logVoteRejected(voterId, "payload_too_large");
      sendJson(res, 413, { error: "payload too large" });
    } else {
      logVoteRejected(voterId, "malformed_json");
      sendJson(res, 400, { error: "malformed JSON body" });
    }
    return;
  }

  const action = body !== null && typeof body === "object" ? (body as Record<string, unknown>).action : undefined;

  try {
    const { round } = castVote(db, voterId, action, onResolved);
    logVoteAccepted(voterId, round.id, action as string);
    sendJson(res, 200, {
      round: { id: round.id, opensAt: round.opens_at, resolvesAt: round.resolves_at },
    });
  } catch (err) {
    if (err instanceof InvalidActionError) {
      logVoteRejected(voterId, "invalid_action", err.roundId);
      sendJson(res, 400, { error: "invalid action" });
    } else if (err instanceof DuplicateVoteError) {
      logVoteRejected(voterId, "duplicate", err.roundId);
      sendJson(res, 409, { error: "already voted this round" });
    } else {
      logInternalError("POST /api/vote", err);
      sendJson(res, 500, { error: "internal error" });
    }
  }
}

// Any connected player may call this — no extra authorization beyond the
// ordinary anonymous identity every endpoint already requires — but
// restartGame itself is what actually enforces "only after victory" and
// "exactly once," by re-reading character.won fresh inside its own
// transaction. This handler never decides that itself; it just reports
// whatever restartGame decided.
export async function handlePostRestart(
  req: IncomingMessage,
  res: ServerResponse,
  db: Database.Database,
  onResolved?: () => void,
): Promise<void> {
  const voterId = getOrCreateVoterId(req, res);

  try {
    const { round } = restartGame(db, voterId, onResolved);
    sendJson(res, 200, {
      round: { id: round.id, opensAt: round.opens_at, resolvesAt: round.resolves_at },
    });
  } catch (err) {
    if (err instanceof RestartNotAllowedError) {
      sendJson(res, 409, { error: "restart is only allowed after reaching EXIT" });
    } else {
      logInternalError("POST /api/restart", err);
      sendJson(res, 500, { error: "internal error" });
    }
  }
}
