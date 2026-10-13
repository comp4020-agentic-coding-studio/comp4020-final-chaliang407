import type { IncomingMessage, ServerResponse } from "node:http";
import type Database from "better-sqlite3";
import { ensureCurrentRound } from "../game/lifecycle.ts";

// Keep connections alive through any intermediary (a browser, a proxy, or
// Fly's own) that might otherwise time out an idle-looking HTTP response.
const HEARTBEAT_MS = 20_000;

export interface EventHub {
  handleConnection(req: IncomingMessage, res: ServerResponse): void;
  // The callback every resolution path — a vote, a state poll, and this
  // hub's own deadline timer — passes to `ensureCurrentRound`/`castVote` as
  // `onResolved`. Whichever one actually observes a round go overdue is the
  // one that ends up calling this.
  notifyResolved(): void;
  scheduleDeadlineTimer(): void;
  close(): void;
}

// Fans out one content-free "a round resolved" event to every open SSE
// connection, and proactively resolves rounds on their own deadline instead
// of waiting for an incidental request. Holds no game state of its own — the
// only thing it owns is the in-memory set of open connections and a single
// pending timer, both deliberately non-authoritative and lost on restart;
// SQLite (via `ensureCurrentRound`) stays the only source of truth, and every
// client resyncs itself from GET /api/state after each event.
export function createEventHub(db: Database.Database): EventHub {
  const connections = new Set<ServerResponse>();
  let deadlineTimer: NodeJS.Timeout | undefined;

  // Content-free by design: no action, no tally, no participation count —
  // just "something resolved, go refetch your own state". Hiding open-round
  // vote totals is enforced by never having a count to put in this event in
  // the first place, not by trusting callers to leave one out. A write to a
  // socket that's already gone but hasn't fired its 'close'/'error' event
  // yet must not be allowed to throw out of here — dropping that one
  // connection is the right response to a broken client, not taking the
  // whole process (every other player's connection included) down with it.
  function broadcast(): void {
    for (const res of connections) {
      try {
        res.write("event: resolved\ndata: {}\n\n");
      } catch (err) {
        console.error("SSE: dropping a connection after a failed write", err);
        connections.delete(res);
      }
    }
  }

  // --- Coalescing and reentrancy guards ---------------------------------
  //
  // `onResolved` can fire more than once in a single synchronous call —
  // `ensureCurrentRound`'s `while (isDue(round))` loop (lifecycle.ts) calls
  // it once per round it rolls forward through, which happens for real
  // whenever the process was stopped, or just slow, across more than one
  // round's duration. Connected clients only need to learn "something
  // resolved, refetch" once in that case, not once per backlogged round —
  // this is a deliberate coalescing of the notification, not a change to
  // round *resolution* itself: every overdue round still resolves,
  // individually and correctly, inside `ensureCurrentRound`; only the
  // real-time *notification* about it is batched down to one.
  //
  // `isScheduling` marks the window while `scheduleDeadlineTimer` is inside
  // its own call to `ensureCurrentRound`. A resolution observed in that
  // window only needs to set `pendingBroadcast`; `scheduleDeadlineTimer`
  // flushes it and rearms the timer itself right after, in the same call —
  // so `notifyResolved` must not *also* schedule a rearm there, or the timer
  // gets built once and then immediately replaced a moment later.
  //
  // A resolution observed *outside* that window (a vote or a GET /api/state
  // request resolving a round the timer doesn't know about yet) makes the
  // currently-armed timer stale — it's still waiting on a round that just
  // closed. `deferScheduled` ensures exactly one `setImmediate` is queued to
  // flush the broadcast and rearm the timer once the triggering call
  // returns, no matter how many times `notifyResolved` fires before that
  // microtask runs.
  let isScheduling = false;
  let pendingBroadcast = false;
  let deferScheduled = false;

  function flushBroadcast(): void {
    if (!pendingBroadcast) return;
    pendingBroadcast = false;
    broadcast();
  }

  function notifyResolved(): void {
    pendingBroadcast = true;
    if (isScheduling || deferScheduled) return;
    deferScheduled = true;
    setImmediate(() => {
      deferScheduled = false;
      flushBroadcast();
      scheduleDeadlineTimer();
    });
  }

  // Single timer, always cleared before being replaced, so overlapping
  // schedule calls (a vote landing right as the old timer is about to fire,
  // a fresh SSE connection, server startup) can never produce two timers
  // racing to resolve — and therefore broadcast — the same round twice.
  // `ensureCurrentRound`'s own `status = 'open'` guard means even a
  // same-instant race between this timer and a request resolves at most
  // once; this keeps the *notification and scheduling* side single as well.
  //
  // Never throws: a failure here (e.g. a transient DB error) only costs the
  // proactive push for this tick — the next request's own `ensureCurrentRound`
  // call, or the next SSE connection, still resolves and rearms correctly,
  // so lazy resolution remains the real fallback it always was.
  function scheduleDeadlineTimer(): void {
    if (deadlineTimer) {
      clearTimeout(deadlineTimer);
      deadlineTimer = undefined;
    }

    try {
      isScheduling = true;
      const round = ensureCurrentRound(db, notifyResolved);
      isScheduling = false;
      flushBroadcast();

      const delay = Math.max(0, new Date(round.resolves_at).getTime() - Date.now());
      deadlineTimer = setTimeout(() => {
        deadlineTimer = undefined;
        scheduleDeadlineTimer();
      }, delay);
      // Doesn't by itself keep the process alive — Fly's own idle/connection
      // tracking (not this timer) is what decides whether the machine can stop.
      deadlineTimer.unref?.();
    } catch (err) {
      isScheduling = false;
      // Any rounds that resolved before the failing step already committed
      // (each resolution is its own DB transaction) and already set
      // `pendingBroadcast` — flush that now so a later, unrelated failure
      // doesn't silently swallow a real resolution's notification.
      flushBroadcast();
      console.error("SSE: round-deadline timer failed; lazy resolution on the next request remains correct", err);
    }
  }

  function handleConnection(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Disables response buffering on common reverse proxies (e.g. nginx);
      // harmless, and a no-op, everywhere else, including Fly's proxy.
      "x-accel-buffering": "no",
    });
    // A leading comment, not an event: establishes the stream immediately
    // without handing EventSource an onmessage payload to parse.
    res.write(": connected\n\n");
    connections.add(res);

    // Symmetric cleanup: a dropped connection can surface as the request
    // closing, the response closing, or the response erroring, depending on
    // which side of the pipe actually failed — removing on only one of these
    // can leave a dead response sitting in `connections` until the next
    // broadcast or heartbeat happens to fail a write against it.
    // `Set.delete` is idempotent, so more than one of these firing for the
    // same disconnect is harmless.
    const cleanup = (): void => {
      connections.delete(res);
    };
    req.on("close", cleanup);
    res.on("close", cleanup);
    res.on("error", cleanup);
  }

  const heartbeatTimer: NodeJS.Timeout = setInterval(() => {
    for (const res of connections) {
      try {
        res.write(": heartbeat\n\n");
      } catch (err) {
        console.error("SSE: dropping a connection after a failed heartbeat write", err);
        connections.delete(res);
      }
    }
  }, HEARTBEAT_MS);
  heartbeatTimer.unref?.();

  function close(): void {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    clearInterval(heartbeatTimer);
    for (const res of connections) res.end();
    connections.clear();
  }

  return { handleConnection, notifyResolved, scheduleDeadlineTimer, close };
}
