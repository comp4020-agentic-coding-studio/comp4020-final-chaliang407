import { expect, inject, it } from "vitest";

// Runs against the same RUNNING app as spec/realtime.test.ts (see that
// file's header comment for why: no mock server, no second in-memory model).
// This file is scoped to C10's identity/authorization questions specifically:
// are two cookie jars actually distinct identities, is one voter's private
// state reachable from another's cookie, and does none of that change what
// C9 already shipped (hidden open-round tallies, one vote per voter per
// round, lazy resolution).
const baseUrl = inject("baseUrl");
const TEST_TIMEOUT_MS = 15000;

interface StatePayload {
  character: { position: number; level: number };
  round: { id: number; opensAt: string; resolvesAt: string; status: string; hasVoted: boolean };
  recentRounds: { id: number; result: string; tally: Record<string, number> }[];
}

// One cookie jar per simulated independent browser/voter, same as
// spec/realtime.test.ts's Client — duplicated here rather than imported so
// this file reads standalone, matching this project's existing spec/*.test.ts
// pattern of self-contained files.
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

it("assigns two cookie-less clients distinct voter identities", async () => {
  const a = new Client();
  const b = new Client();
  await a.state();
  await b.state();

  expect(a.cookie).toBeDefined();
  expect(b.cookie).toBeDefined();
  expect(a.cookie).not.toBe(b.cookie);
});

it("reuses the same identity across requests once a cookie is set, with no new cookie reissued", async () => {
  const client = new Client();
  await client.state();
  const firstCookie = client.cookie;
  expect(firstCookie).toBeDefined();

  // A second request carrying the same cookie must not mint a new one — the
  // server trusts the existing cookie rather than treating every request as
  // a fresh identity (src/http/voter.ts: getOrCreateVoterId only sets
  // set-cookie on the mint branch).
  const res = await fetch(new URL("/api/state", baseUrl), { headers: { cookie: firstCookie! } });
  expect(res.status).toBe(200);
  expect(res.headers.get("set-cookie")).toBeNull();
});

it(
  "rejects a second vote from the same cookie in the same round, independent of other voters",
  async () => {
    const voter = new Client();
    const bystander = new Client();
    await voter.state();
    await bystander.state();

    const first = await voter.vote("LEFT");
    expect(first.status).toBe(200);
    const second = await voter.vote("RIGHT");
    expect(second.status).toBe(409);
    // Response body/shape is unchanged by the privacy-hardening fix to
    // DuplicateVoteError's internal message (src/db/votes.ts) — the voter's
    // own cookie never carries their own voter id back to them anyway, but
    // this nails down that the wire contract didn't move either.
    const secondBody = await second.json();
    expect(secondBody).toEqual({ error: "already voted this round" });
    const secondBodyText = JSON.stringify(secondBody);
    expect(secondBodyText).not.toContain(voter.cookie);

    // The duplicate rejection is scoped to this cookie's identity, not global
    // to the round — a distinct cookie can still vote in the same round.
    const bystanderVote = await bystander.vote("RIGHT");
    expect(bystanderVote.status).toBe(200);
  },
  TEST_TIMEOUT_MS,
);

it(
  "keeps hasVoted independent per cookie: one voting does not mark another as having voted",
  async () => {
    const a = new Client();
    const b = new Client();
    const before = await a.state();
    expect(before.round.hasVoted).toBe(false);
    const bBefore = await b.state();
    expect(bBefore.round.hasVoted).toBe(false);

    await a.vote("JUMP");

    const aAfter = await a.state();
    const bAfter = await b.state();
    expect(aAfter.round.hasVoted).toBe(true);
    expect(bAfter.round.hasVoted).toBe(false);
  },
  TEST_TIMEOUT_MS,
);

it(
  "gives no client a way to read or influence another client's private state through the API surface",
  async () => {
    const a = new Client();
    const b = new Client();
    await a.state();
    await b.state();

    // Neither endpoint accepts any identity-selecting input beyond the
    // request's own cookie — confirmed by trying the only plausible spoof
    // surfaces: a voter id in the vote body, and a query string on /api/state.
    const spoofAttempt = await fetch(new URL("/api/vote", baseUrl), {
      method: "POST",
      headers: { cookie: a.cookie!, "content-type": "application/json" },
      body: JSON.stringify({ action: "LEFT", voterId: "someone-else", voter_id: "someone-else" }),
    });
    expect(spoofAttempt.status).toBe(200); // accepted as a's own vote, ignoring the extra fields

    const aState = await a.state();
    expect(aState.round.hasVoted).toBe(true);
    const bState = await b.state();
    expect(bState.round.hasVoted).toBe(false); // untouched by a's vote

    const queryAttempt = await fetch(new URL(`/api/state?voterId=${b.cookie}`, baseUrl), {
      headers: { cookie: a.cookie! },
    });
    const queryState: StatePayload = await queryAttempt.json();
    expect(queryState.round.hasVoted).toBe(true); // still a's own state, query string ignored
  },
  TEST_TIMEOUT_MS,
);

it(
  "keeps an SSE connection and its own GET/POST calls identified consistently, without exposing tallies on reconnect",
  async () => {
    const client = new Client();
    await client.state();
    const cookie = client.cookie!;

    const first = await fetch(new URL("/api/events", baseUrl), {
      headers: { cookie },
    });
    expect(first.status).toBe(200);
    expect(first.headers.get("set-cookie")).toBeNull(); // identity already established; SSE reuses it, doesn't reissue it
    await first.body?.cancel();

    // Reconnecting (simulating EventSource's own auto-reconnect) with the
    // same cookie must still be recognised as the same identity, not minted
    // fresh — this is what "connection and reconnection" logging depends on
    // being meaningful rather than every reconnect looking like a new player.
    const second = await fetch(new URL("/api/events", baseUrl), {
      headers: { cookie },
    });
    expect(second.status).toBe(200);
    expect(second.headers.get("set-cookie")).toBeNull();
    await second.body?.cancel();

    const state = await client.state();
    expect(Object.keys(state.round).sort()).toEqual(["hasVoted", "id", "opensAt", "resolvesAt", "status"].sort());
  },
  TEST_TIMEOUT_MS,
);
