import { expect, inject, it } from "vitest";

// Runs against the same RUNNING app every other spec/*.test.ts uses
// (spec/global-setup.ts finds it) — no mocked server, no second in-memory
// model, so these tests hold whatever the real /api/server/db code actually
// does.
//
// Scope note: this file drives /api/state, /api/vote, and /api/events
// directly over HTTP/fetch — it verifies the server's resolution lifecycle,
// SSE protocol, and privacy contract exactly as a browser would receive them
// on the wire. It does NOT load public/index.html or run a real browser:
// there is no Playwright/Puppeteer (or similar) installed in this project,
// so EventSource reconnect handling, poll()'s overlap guard, the reveal
// animation, keyboard controls, and reduced-motion behaviour are NOT
// exercised by anything in this file. Those were verified by reading the
// client script and by manual exercise of the running app in a browser
// during this change; they still need a human to click through them again
// before this is treated as browser-verified, and any future automation of
// them needs an actual browser-automation tool added to the project first.
const baseUrl = inject("baseUrl");

// The container (and local dev) run with config.ts's default
// ROUND_DURATION_MS = 3000, so every round-boundary wait below is bounded by
// that; timeouts are generous multiples of it rather than tied to 1000ms,
// since the thing each test is *timing* is propagation delay, not the round
// itself.
const TEST_TIMEOUT_MS = 15000;

interface StateRound {
  id: number;
  opensAt: string;
  resolvesAt: string;
  status: string;
  hasVoted: boolean;
}

interface StatePayload {
  character: { position: number; level: number };
  round: StateRound;
  recentRounds: {
    id: number;
    result: string;
    tally: { LEFT: number; JUMP: number; RIGHT: number };
  }[];
}

// One cookie jar per simulated independent browser/voter — the server
// identifies voters only by this cookie (src/http/voter.ts), so a fresh
// Client with no cookie is a fresh anonymous voter, same as a new tab.
class Client {
  cookie: string | undefined;

  private applyCookie(res: Response): void {
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) this.cookie = setCookie.split(";")[0];
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return { ...(this.cookie ? { cookie: this.cookie } : {}), ...extra };
  }

  async state(): Promise<StatePayload> {
    const res = await fetch(new URL("/api/state", baseUrl), { headers: this.headers() });
    this.applyCookie(res);
    expect(res.status).toBe(200);
    return res.json();
  }

  async vote(action: string): Promise<Response> {
    const res = await fetch(new URL("/api/vote", baseUrl), {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify({ action }),
    });
    this.applyCookie(res);
    return res;
  }

  async waitForRoundChange(fromRoundId: number, timeoutMs = TEST_TIMEOUT_MS): Promise<StatePayload> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const state = await this.state();
      if (state.round.id !== fromRoundId) return state;
      if (Date.now() > deadline) throw new Error(`round ${fromRoundId} never resolved within ${timeoutMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

interface SseFrame {
  event: string | undefined;
  data: string;
  receivedAt: number;
}

interface EventStream {
  next(timeoutMs?: number): Promise<SseFrame>;
  // Gathers every frame received during the given window rather than
  // resolving on the first one — this is what "exactly one event" and "no
  // vote-activity timing leak" need: those are claims about everything that
  // *did* or *didn't* arrive over an interval, not about the next frame.
  collectFor(windowMs: number): Promise<SseFrame[]>;
  close(): void;
}

function parseFrame(raw: string): { event: string | undefined; data: string } {
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  return { event, data: dataLines.join("\n") };
}

// A minimal browser-compatible SSE reader built on fetch + ReadableStream,
// since Node has no global EventSource — but the wire format read here
// (event:/data: lines terminated by a blank line) is exactly what the
// browser's EventSource in public/index.html parses.
async function openEvents(cookie: string | undefined): Promise<EventStream> {
  const controller = new AbortController();
  const res = await fetch(new URL("/api/events", baseUrl), {
    headers: cookie ? { cookie } : {},
    signal: controller.signal,
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const queue: SseFrame[] = [];
  const waiters: ((frame: SseFrame) => void)[] = [];
  let buffer = "";

  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const parsed = parseFrame(raw);
          // Lines with no "event:" are pure comments (the initial ": connected"
          // and heartbeat pings) — not real SSE events, so EventSource's
          // onmessage/addEventListener never sees them either.
          if (!parsed.event) continue;
          const frame: SseFrame = { ...parsed, receivedAt: Date.now() };
          const waiter = waiters.shift();
          if (waiter) waiter(frame);
          else queue.push(frame);
        }
      }
    } catch {
      // Connection aborted by close() — expected, nothing to surface.
    }
  })();

  function next(timeoutMs = TEST_TIMEOUT_MS): Promise<SseFrame> {
    if (queue.length) return Promise.resolve(queue.shift()!);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no SSE event within ${timeoutMs}ms`)), timeoutMs);
      waiters.push((frame) => {
        clearTimeout(timer);
        resolve(frame);
      });
    });
  }

  async function collectFor(windowMs: number): Promise<SseFrame[]> {
    const collected: SseFrame[] = [...queue];
    queue.length = 0;
    const deadline = Date.now() + windowMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return collected;
      try {
        collected.push(await next(remaining));
      } catch {
        return collected; // timed out waiting for the next frame — window's up
      }
    }
  }

  return {
    next,
    collectFor,
    close(): void {
      controller.abort();
    },
  };
}

it(
  "pushes a resolved event to two independent clients within ~1s of the deadline, with no reload",
  async () => {
    const a = new Client();
    const b = new Client();
    const before = await a.state();
    const openRoundId = before.round.id;
    const deadline = new Date(before.round.resolvesAt).getTime();

    const streamA = await openEvents(a.cookie);
    const streamB = await openEvents(b.cookie);
    try {
      const [frameA, frameB] = await Promise.all([streamA.next(), streamB.next()]);

      expect(frameA.event).toBe("resolved");
      expect(frameB.event).toBe("resolved");

      // "Approximately one second" propagation, measured from the round's
      // own deadline (not from when the test happened to start) — this is
      // the number fixed 1.2s client polling could never bound (see audit).
      expect(frameA.receivedAt - deadline).toBeLessThan(1000);
      expect(frameB.receivedAt - deadline).toBeLessThan(1000);
      // Both tabs learn about it at essentially the same moment — a single
      // server-side push, not two independently-phased poll intervals.
      expect(Math.abs(frameA.receivedAt - frameB.receivedAt)).toBeLessThan(300);

      const after = await a.state();
      expect(after.round.id).not.toBe(openRoundId);
      expect(after.recentRounds.some((r) => r.id === openRoundId)).toBe(true);
    } finally {
      streamA.close();
      streamB.close();
    }
  },
  TEST_TIMEOUT_MS,
);

it(
  "sends exactly one resolution notification per round, even right at the deadline",
  async () => {
    const watcher = new Client();
    const before = await watcher.state();
    const openRoundId = before.round.id;
    const deadline = new Date(before.round.resolvesAt).getTime();

    const stream = await openEvents(watcher.cookie);
    try {
      // A window that comfortably spans the round's own deadline but stops
      // well short of the *next* round's deadline (config.ts's default
      // ROUND_DURATION_MS = 3000), so any extra event caught here can only be
      // a duplicate notification for this same resolution, not the next
      // round's own (legitimate) event arriving.
      const windowMs = Math.max(0, deadline - Date.now()) + 1800;
      const frames = await stream.collectFor(windowMs);

      const resolvedFrames = frames.filter((f) => f.event === "resolved");
      expect(resolvedFrames).toHaveLength(1);

      const after = await watcher.state();
      expect(after.recentRounds.some((r) => r.id === openRoundId)).toBe(true);
    } finally {
      stream.close();
    }
  },
  TEST_TIMEOUT_MS,
);

it(
  "gives an empty round and a populated round identical SSE cadence — no vote-activity timing leak",
  async () => {
    const watcher = new Client();

    // Empty round: nobody this test controls votes.
    const beforeEmpty = await watcher.state();
    const emptyDeadline = new Date(beforeEmpty.round.resolvesAt).getTime();
    const emptyStream = await openEvents(watcher.cookie);
    let emptyFrame: SseFrame;
    try {
      emptyFrame = await emptyStream.next();
    } finally {
      emptyStream.close();
    }

    // Populated round: two voters actually cast votes this time.
    const afterEmpty = await watcher.state();
    const populatedDeadline = new Date(afterEmpty.round.resolvesAt).getTime();
    const populatedStream = await openEvents(watcher.cookie);
    let populatedFrame: SseFrame;
    try {
      const a = new Client();
      const b = new Client();
      await Promise.all([a.vote("LEFT"), b.vote("RIGHT")]);
      populatedFrame = await populatedStream.next();
    } finally {
      populatedStream.close();
    }

    // Identical event shape either way — content-free, so there is nothing
    // in the payload itself that could distinguish "nobody voted" from
    // "people voted" even by inspection.
    expect(emptyFrame.event).toBe("resolved");
    expect(populatedFrame.event).toBe("resolved");
    expect(emptyFrame.data).toBe(populatedFrame.data);

    // And no distinguishing signal in *when* the event arrives relative to
    // the round's own deadline either — a would-be "participation" leak
    // could show up as, say, the event firing faster once votes exist.
    const emptyDelay = emptyFrame.receivedAt - emptyDeadline;
    const populatedDelay = populatedFrame.receivedAt - populatedDeadline;
    expect(emptyDelay).toBeLessThan(1000);
    expect(populatedDelay).toBeLessThan(1000);
    expect(Math.abs(emptyDelay - populatedDelay)).toBeLessThan(500);
  },
  TEST_TIMEOUT_MS,
);

it(
  "never puts an open-round tally, participation count, or leader in the resolved event or /api/state",
  async () => {
    const voter = new Client();
    const watcher = new Client();
    const before = await watcher.state();
    const openRoundId = before.round.id;

    // Open-round keys must be exactly these — no tally, no count, nothing
    // that would let a client infer who's ahead while the round is open.
    expect(Object.keys(before.round).sort()).toEqual(
      ["hasVoted", "id", "opensAt", "resolvesAt", "status"].sort(),
    );

    const stream = await openEvents(watcher.cookie);
    try {
      // Cast a real vote so there is tally data in the database that *could*
      // leak — the assertion is that it doesn't, not that there's nothing to leak.
      const voteRes = await voter.vote("RIGHT");
      expect(voteRes.status).toBe(200);

      const frame = await stream.next();
      expect(frame.event).toBe("resolved");
      // Content-free by construction: no action, no counts, nothing at all.
      expect(frame.data).toBe("{}");

      const afterVoteButSameRound = await watcher.state();
      if (afterVoteButSameRound.round.id === openRoundId) {
        expect(Object.keys(afterVoteButSameRound.round).sort()).toEqual(
          ["hasVoted", "id", "opensAt", "resolvesAt", "status"].sort(),
        );
      }
    } finally {
      stream.close();
    }
  },
  TEST_TIMEOUT_MS,
);

it(
  "rejects a second vote from the same voter in the same round, but accepts simultaneous votes from distinct voters",
  async () => {
    const dup = new Client();
    const before = await dup.state();
    const openRoundId = before.round.id;

    const first = await dup.vote("LEFT");
    expect(first.status).toBe(200);
    const second = await dup.vote("RIGHT");
    expect(second.status).toBe(409);

    const left2 = new Client();
    const left3 = new Client();
    const right2 = new Client();
    const results = await Promise.all([
      left2.vote("LEFT"),
      left3.vote("LEFT"),
      right2.vote("RIGHT"),
    ]);
    for (const res of results) expect(res.status).toBe(200);

    const resolved = await dup.waitForRoundChange(openRoundId);
    const round = resolved.recentRounds.find((r) => r.id === openRoundId);
    expect(round).toBeDefined();
    // dup(LEFT) + left2(LEFT) + left3(LEFT) = 3, right2(RIGHT) = 1 — simultaneous
    // concurrent votes all landed exactly once each, no lost or duplicated writes.
    expect(round!.tally).toEqual({ LEFT: 3, JUMP: 0, RIGHT: 1 });
    expect(round!.result).toBe("LEFT");
  },
  TEST_TIMEOUT_MS,
);

it(
  "recovers full, correct state after a client disconnects and reconnects, missing a resolution in between",
  async () => {
    const client = new Client();
    const before = await client.state();
    const missedRoundId = before.round.id;

    const firstStream = await openEvents(client.cookie);
    // Simulate a dropped connection (phone sleeps, tab backgrounded, network
    // blip) — closed before the round resolves, so this client receives no
    // 'resolved' event for it at all.
    firstStream.close();

    const afterMissed = await client.waitForRoundChange(missedRoundId);
    expect(afterMissed.recentRounds.some((r) => r.id === missedRoundId)).toBe(true);

    // Reconnecting is what recovers truth, not a replayed event log: a fresh
    // SSE connection plus one GET /api/state is the entire recovery story.
    const secondStream = await openEvents(client.cookie);
    try {
      const resynced = await client.state();
      expect(resynced.round.id).not.toBe(missedRoundId);
      expect(resynced.round.hasVoted).toBe(false);

      // And the new connection resumes ordinary push behaviour going forward.
      const openRoundId = resynced.round.id;
      await client.vote("JUMP");
      const frame = await secondStream.next();
      expect(frame.event).toBe("resolved");
      const after = await client.state();
      expect(after.recentRounds.some((r) => r.id === openRoundId)).toBe(true);
    } finally {
      secondStream.close();
    }
  },
  TEST_TIMEOUT_MS,
);

it(
  "keeps empty rounds and genuine ties distinguishable, and leaves the character untouched by either",
  async () => {
    const watcher = new Client();

    // Empty round: let the currently open round resolve with no vote from
    // anyone this test controls.
    const beforeEmpty = await watcher.state();
    const emptyRoundId = beforeEmpty.round.id;
    const charBeforeEmpty = beforeEmpty.character;
    const afterEmpty = await watcher.waitForRoundChange(emptyRoundId);
    const emptyRound = afterEmpty.recentRounds.find((r) => r.id === emptyRoundId);
    expect(emptyRound).toBeDefined();
    expect(emptyRound!.result).toBe("TIE");
    expect(emptyRound!.tally).toEqual({ LEFT: 0, JUMP: 0, RIGHT: 0 });
    expect(afterEmpty.character).toEqual(charBeforeEmpty);

    // Genuine tie: two distinct voters disagree, one LEFT one RIGHT, so
    // there's no unique majority — but votes were actually cast.
    const left = new Client();
    const right = new Client();
    const tieRoundId = afterEmpty.round.id;
    const charBeforeTie = afterEmpty.character;
    await left.vote("LEFT");
    await right.vote("RIGHT");
    const afterTie = await watcher.waitForRoundChange(tieRoundId);
    const tieRound = afterTie.recentRounds.find((r) => r.id === tieRoundId);
    expect(tieRound).toBeDefined();
    expect(tieRound!.result).toBe("TIE");
    expect(tieRound!.tally).toEqual({ LEFT: 1, JUMP: 0, RIGHT: 1 });
    // Same result label as the empty round, but the tally is what tells the
    // two apart — the protocol preserves that distinction end to end.
    expect(tieRound!.tally).not.toEqual(emptyRound!.tally);
    expect(afterTie.character).toEqual(charBeforeTie);
  },
  TEST_TIMEOUT_MS,
);
