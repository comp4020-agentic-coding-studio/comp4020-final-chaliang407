import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deriveLabel,
  logIdentityCreated,
  logInternalError,
  logRoundResolved,
  logSseConnected,
  logSseDisconnected,
  logVoteAccepted,
  logVoteRejected,
} from "../src/logging.ts";
import { DuplicateVoteError } from "../src/db/votes.ts";

// Unlike every other spec/*.test.ts file, these never touch the network.
// spec/README.md and spec/global-setup.ts establish that the running app is
// a separate process reached only over HTTP — there's no way to read *its*
// stdout from here. So "is a log line structured correctly" and "does a log
// line ever leak a raw identifier" can only be checked by calling the same
// logging functions src/api.ts, src/http/events.ts, src/http/voter.ts and
// src/game/lifecycle.ts call, in-process, and inspecting what reaches
// console.log — exactly what this file does.

function readEvents(spy: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
  return spy.mock.calls.map((call) => JSON.parse(call[0] as string));
}

describe("structured logging", () => {
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    spy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    spy.mockRestore();
  });

  it("derives a short, stable, non-reversible label from a voter id", () => {
    const voterId = "11111111-2222-3333-4444-555555555555";
    const a = deriveLabel(voterId);
    const b = deriveLabel(voterId);
    expect(a).toBe(b); // stable across calls within this process
    expect(a).toMatch(/^[0-9a-f]{10}$/); // short, fixed-length, printable
    expect(a).not.toContain(voterId);
    expect(a.length).toBeLessThan(voterId.length);
  });

  it("gives distinct voters distinct labels", () => {
    const a = deriveLabel("11111111-2222-3333-4444-555555555555");
    const b = deriveLabel("66666666-7777-8888-9999-000000000000");
    expect(a).not.toBe(b);
  });

  it("logs identity.created as one structured JSON line carrying only the label", () => {
    const voterId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    logIdentityCreated(voterId);
    const events = readEvents(spy).filter((e) => e.event === "identity.created");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ player: deriveLabel(voterId) });
    expect(typeof events[0].ts).toBe("string");
  });

  it("logs sse connect/disconnect with the connection count, keyed by player label", () => {
    const voterId = "cafebabe-cafe-babe-cafe-babecafebabe";
    logSseConnected(voterId, 2);
    logSseDisconnected(voterId, 1);
    const events = readEvents(spy);
    expect(events.find((e) => e.event === "sse.connected")).toMatchObject({
      player: deriveLabel(voterId),
      openConnections: 2,
    });
    expect(events.find((e) => e.event === "sse.disconnected")).toMatchObject({
      player: deriveLabel(voterId),
      openConnections: 1,
    });
  });

  it("logs an accepted vote with player, round and action, and a rejected vote with its reason", () => {
    const voterId = "deadbeef-dead-beef-dead-beefdeadbeef";
    logVoteAccepted(voterId, 42, "LEFT");
    logVoteRejected(voterId, "duplicate", 42);
    const events = readEvents(spy);
    expect(events.find((e) => e.event === "vote.accepted")).toMatchObject({
      player: deriveLabel(voterId),
      round: 42,
      action: "LEFT",
    });
    expect(events.find((e) => e.event === "vote.rejected")).toMatchObject({
      player: deriveLabel(voterId),
      reason: "duplicate",
      round: 42,
    });
  });

  it("logs round resolution with the final tally and whether the character actually moved", () => {
    logRoundResolved({
      roundId: 7,
      result: "RIGHT",
      tally: { UP: 0, DOWN: 0, LEFT: 1, RIGHT: 2 },
      characterBefore: { x: 1, y: 1, won: false, score: 0, level: 1 },
      characterAfter: { x: 2, y: 1, won: false, score: 0, level: 1 },
      collided: false,
      advancedLevel: false,
    });
    const event = readEvents(spy).find((e) => e.event === "round.resolved" && e.round === 7);
    expect(event).toMatchObject({
      result: "RIGHT",
      tally: { UP: 0, DOWN: 0, LEFT: 1, RIGHT: 2 },
      moved: true,
    });
  });

  it("marks a resolved-but-unmoved round (e.g. TIE, or an empty round) as not moved", () => {
    logRoundResolved({
      roundId: 8,
      result: "TIE",
      tally: { UP: 0, DOWN: 0, LEFT: 1, RIGHT: 1 },
      characterBefore: { x: 3, y: 1, won: false, score: 0, level: 1 },
      characterAfter: { x: 3, y: 1, won: false, score: 0, level: 1 },
      collided: false,
      advancedLevel: false,
    });
    const event = readEvents(spy).find((e) => e.event === "round.resolved" && e.round === 8);
    expect(event).toMatchObject({ moved: false });
  });

  it("flags wonThisRound only on the round where the character reaches level 10's EXIT", () => {
    logRoundResolved({
      roundId: 9,
      result: "DOWN",
      tally: { UP: 0, DOWN: 2, LEFT: 0, RIGHT: 0 },
      characterBefore: { x: 7, y: 6, won: false, score: 0, level: 10 },
      characterAfter: { x: 7, y: 7, won: true, score: 0, level: 10 },
      collided: false,
      advancedLevel: false,
    });
    const event = readEvents(spy).find((e) => e.event === "round.resolved" && e.round === 9);
    expect(event).toMatchObject({ moved: true, wonThisRound: true });
  });

  it("flags pelletCollected only on the round where score actually increased and no collision occurred", () => {
    logRoundResolved({
      roundId: 10,
      result: "RIGHT",
      tally: { UP: 0, DOWN: 0, LEFT: 0, RIGHT: 1 },
      characterBefore: { x: 1, y: 1, won: false, score: 0, level: 1 },
      characterAfter: { x: 2, y: 1, won: false, score: 10, level: 1 },
      collided: false,
      advancedLevel: false,
    });
    const event = readEvents(spy).find((e) => e.event === "round.resolved" && e.round === 10);
    expect(event).toMatchObject({ pelletCollected: true });
  });

  it("flags advancedLevel only on the round where the character's level actually increased", () => {
    logRoundResolved({
      roundId: 11,
      result: "RIGHT",
      tally: { UP: 0, DOWN: 0, LEFT: 0, RIGHT: 1 },
      characterBefore: { x: 7, y: 7, won: false, score: 20, level: 1 },
      characterAfter: { x: 1, y: 1, won: false, score: 20, level: 2 },
      collided: false,
      advancedLevel: true,
    });
    const event = readEvents(spy).find((e) => e.event === "round.resolved" && e.round === 11);
    expect(event).toMatchObject({ advancedLevel: true });
  });

  it("flags collided and never pelletCollected on a round where an enemy collision overrode a score-decreasing penalty", () => {
    logRoundResolved({
      roundId: 12,
      result: "RIGHT",
      tally: { UP: 0, DOWN: 0, LEFT: 0, RIGHT: 1 },
      characterBefore: { x: 5, y: 5, won: false, score: 30, level: 3 },
      characterAfter: { x: 1, y: 1, won: false, score: 10, level: 3 },
      collided: true,
      advancedLevel: false,
    });
    const event = readEvents(spy).find((e) => e.event === "round.resolved" && e.round === 12);
    expect(event).toMatchObject({ collided: true, pelletCollected: false });
  });

  it("never emits a raw voter id, a cookie, or a request-body field in any log line", () => {
    const voterId = "11112222-3333-4444-5555-666677778888";
    logIdentityCreated(voterId);
    logSseConnected(voterId, 1);
    logVoteAccepted(voterId, 1, "UP");
    logVoteRejected(voterId, "invalid_action", 1);
    logRoundResolved({
      roundId: 1,
      result: "UP",
      tally: { UP: 1, DOWN: 0, LEFT: 0, RIGHT: 0 },
      characterBefore: { x: 1, y: 1, won: false, score: 0, level: 1 },
      characterAfter: { x: 1, y: 0, won: false, score: 0, level: 1 },
      collided: false,
      advancedLevel: false,
    });
    for (const [line] of spy.mock.calls) {
      const raw = String(line);
      expect(raw).not.toContain(voterId);
      expect(raw.toLowerCase()).not.toContain("voter_id");
      expect(raw.toLowerCase()).not.toContain("cookie");
      expect(raw.toLowerCase()).not.toContain("action=");
    }
  });

  it("never embeds a voter id in DuplicateVoteError's message, stack, or any field", () => {
    const voterId = "99998888-7777-6666-5555-444433332222";
    const err = new DuplicateVoteError(42);
    expect(err.message).not.toContain(voterId);
    expect(err.message).toContain("42"); // roundId still present, for operator-useful context
    expect(err.roundId).toBe(42);
    expect(err.stack ?? "").not.toContain(voterId);
    // Guards the regression this error class actually had: an earlier
    // version took a second (voterId) constructor argument and interpolated
    // it into .message. Only one argument is accepted now.
    expect(DuplicateVoteError.length).toBe(1);
  });

  it("logInternalError reports a safe category and operation, never the error's own message or stack", () => {
    const voterId = "55556666-7777-8888-9999-aaaabbbbcccc";
    const err = new TypeError(`something went wrong for voter ${voterId}`);
    logInternalError("POST /api/vote", err);

    const events = readEvents(spy).filter((e) => e.event === "internal_error");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ operation: "POST /api/vote", errorType: "TypeError" });
    expect(events[0]).not.toHaveProperty("message");
    expect(events[0]).not.toHaveProperty("stack");

    const raw = String(spy.mock.calls.at(-1)?.[0]);
    expect(raw).not.toContain(voterId);
    expect(raw).not.toContain(err.message);
  });

  it("logInternalError falls back to a safe category for a non-Error thrown value", () => {
    logInternalError("GET /api/state", "a raw string someone threw, not an Error");
    const event = readEvents(spy).find((e) => e.event === "internal_error");
    expect(event).toMatchObject({ operation: "GET /api/state", errorType: "unknown" });
    const raw = String(spy.mock.calls.at(-1)?.[0]);
    expect(raw).not.toContain("a raw string someone threw");
  });
});
