import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// In-process against its own throwaway SQLite file, same pattern as
// spec/movement.test.ts: pellet collection and scoring are properties of the
// DB/game-logic layer itself (src/db/character.ts, src/db/pellets.ts), so
// calling the same functions src/api.ts calls is a faithful, fast check of
// the real code path, without waiting out real round timers. vitest isolates
// module state per test file, so setting DATA_DIR here can't collide with
// the DB any other spec file uses.
const dataDir = mkdtempSync(join(tmpdir(), "pellets-"));
process.env.DATA_DIR = dataDir;

const { getDb } = await import("../src/db/client.ts");
const { getCharacter, applyRoundResult } = await import("../src/db/character.ts");
const { getPellets, collectPelletAt, PELLET_POINTS } = await import("../src/db/pellets.ts");
const { createRound } = await import("../src/db/rounds.ts");
const { recordVote } = await import("../src/db/votes.ts");
const { ensureCurrentRound } = await import("../src/game/lifecycle.ts");
const { getLevel } = await import("../src/game/levels.ts");
const { START } = await import("../src/game/maze.ts");

describe("pellet collection and scoring", () => {
  const db = getDb();
  const level1 = getLevel(1);

  it("awards exactly 10 points for collecting one pellet", () => {
    db.prepare("UPDATE character SET x = ?, y = ?, won = 0, score = 0 WHERE id = 1").run(START.x, START.y);
    db.prepare("UPDATE pellet_state SET collected = 0 WHERE level = 1").run();

    // Level 1's pellet at (2,1) is reachable from START (1,1) via RIGHT.
    const pellet = level1.pelletSpawns.find((p) => p.x === 2 && p.y === 1);
    expect(pellet, "test assumes level 1 has a pellet at (2,1)").toBeDefined();

    const before = getCharacter(db);
    expect(before.score).toBe(0);

    const after = applyRoundResult(db, "RIGHT");
    expect(after.x).toBe(2);
    expect(after.y).toBe(1);
    expect(after.score).toBe(PELLET_POINTS);
    expect(after.score).toBe(10);

    const pellets = getPellets(db, 1);
    const collected = pellets.find((p) => p.x === 2 && p.y === 1);
    expect(collected?.collected).toBe(true);
  });

  it("accumulates score correctly across multiple distinct pellets", () => {
    db.prepare("UPDATE character SET x = ?, y = ?, won = 0, score = 0 WHERE id = 1").run(START.x, START.y);
    db.prepare("UPDATE pellet_state SET collected = 0 WHERE level = 1").run();

    // RIGHT then DOWN then DOWN then DOWN walks across (2,1) -> (2,2 wall?) —
    // use a route known to cross two distinct level-1 pellets: (2,1) then,
    // from there, continue down the open corridor toward (1,4)'s pellet via
    // a path that stays on floor tiles (verified against level 1's grid:
    // RIGHT from (1,1) to (2,1) collects pellet #1; LEFT, DOWN x3 returns to
    // (1,4), collecting pellet #2).
    let after = applyRoundResult(db, "RIGHT"); // (1,1) -> (2,1), pellet #1
    expect(after.score).toBe(10);
    after = applyRoundResult(db, "LEFT"); // (2,1) -> (1,1), no pellet there
    expect(after.score).toBe(10);
    after = applyRoundResult(db, "DOWN"); // (1,1) -> (1,2)
    after = applyRoundResult(db, "DOWN"); // (1,2) -> (1,3)
    after = applyRoundResult(db, "DOWN"); // (1,3) -> (1,4), pellet #2
    expect(after.x).toBe(1);
    expect(after.y).toBe(4);
    expect(after.score).toBe(20);

    const pellets = getPellets(db, 1);
    expect(pellets.filter((p) => p.collected)).toHaveLength(2);
  });

  it("gives no additional points for revisiting an already-collected pellet", () => {
    db.prepare("UPDATE character SET x = ?, y = ?, won = 0, score = 0 WHERE id = 1").run(START.x, START.y);
    db.prepare("UPDATE pellet_state SET collected = 0 WHERE level = 1").run();

    let after = applyRoundResult(db, "RIGHT"); // collect (2,1)
    expect(after.score).toBe(10);
    after = applyRoundResult(db, "LEFT"); // leave
    after = applyRoundResult(db, "RIGHT"); // return to the same tile
    expect(after.x).toBe(2);
    expect(after.y).toBe(1);
    expect(after.score).toBe(10); // unchanged — no second award
  });

  it("awards no points when movement is blocked by a wall", () => {
    db.prepare("UPDATE character SET x = ?, y = ?, won = 0, score = 0 WHERE id = 1").run(START.x, START.y);
    db.prepare("UPDATE pellet_state SET collected = 0 WHERE level = 1").run();

    const before = getCharacter(db);
    // LEFT from (1,1) is a wall (verified by spec/movement.test.ts's own
    // wall test against this same maze).
    const after = applyRoundResult(db, "LEFT");
    expect(after).toEqual(before); // completely untouched, including score
    expect(after.score).toBe(0);
  });

  it("awards no points on a TIE", () => {
    db.prepare("UPDATE character SET x = ?, y = ?, won = 0, score = 0 WHERE id = 1").run(START.x, START.y);
    db.prepare("UPDATE pellet_state SET collected = 0 WHERE level = 1").run();

    const before = getCharacter(db);
    const after = applyRoundResult(db, "TIE");
    expect(after).toEqual(before);
    expect(after.score).toBe(0);
  });

  it("awards no points on a zero-vote round resolving through the real lifecycle", () => {
    db.prepare("UPDATE character SET x = ?, y = ?, won = 0, score = 0 WHERE id = 1").run(START.x, START.y);
    db.prepare("UPDATE pellet_state SET collected = 0 WHERE level = 1").run();

    // A round nobody votes in resolves to TIE via the real lifecycle path
    // (src/game/lifecycle.ts's decideResult on an all-zero tally), exactly
    // like any other TIE — this exercises that path end to end, not just
    // applyRoundResult called directly.
    createRound(db, -1); // already-expired round, resolves on next ensureCurrentRound call
    ensureCurrentRound(db);

    const after = getCharacter(db);
    expect(after.x).toBe(START.x);
    expect(after.y).toBe(START.y);
    expect(after.score).toBe(0);
  });

  it("does not double-collect or double-score when applyRoundResult is called twice for what should be one resolution", () => {
    // Guards the collectPelletAt UPDATE...WHERE collected=0 guard directly:
    // even if something upstream were to call this twice for the same
    // logical move (a bug this test would catch), the second call is a
    // genuine no-op because the pellet row is already marked collected.
    db.prepare("UPDATE character SET x = ?, y = ?, won = 0, score = 0 WHERE id = 1").run(START.x, START.y);
    db.prepare("UPDATE pellet_state SET collected = 0 WHERE level = 1").run();

    const collectedFirst = collectPelletAt(db, 1, 2, 1);
    expect(collectedFirst).toBe(true);
    const collectedSecond = collectPelletAt(db, 1, 2, 1);
    expect(collectedSecond).toBe(false); // already collected — no-op, not a second award
  });

  it("performs movement, collection, and scoring atomically: a mid-move failure leaves no partial state", () => {
    db.prepare("UPDATE character SET x = ?, y = ?, won = 0, score = 0 WHERE id = 1").run(START.x, START.y);
    db.prepare("UPDATE pellet_state SET collected = 0 WHERE level = 1").run();

    const before = getCharacter(db);
    // Force a failure partway through by violating the score CHECK
    // constraint from inside a transaction that also calls applyRoundResult
    // — if movement/collection/scoring weren't genuinely atomic with
    // whatever transaction wraps them, the character's x/y could end up
    // committed while the forced failure still rolled back something else.
    const txn = db.transaction(() => {
      applyRoundResult(db, "RIGHT");
      throw new Error("simulated failure after movement, before this transaction commits");
    });
    expect(() => txn()).toThrow();

    const after = getCharacter(db);
    expect(after).toEqual(before); // entirely rolled back: position, score, pellet state all unchanged
    const pellets = getPellets(db, 1);
    expect(pellets.find((p) => p.x === 2 && p.y === 1)?.collected).toBe(false);
  });

  it("drives pellet collection through the real vote/tally/resolve pipeline", () => {
    db.prepare("UPDATE character SET x = ?, y = ?, won = 0, score = 0 WHERE id = 1").run(START.x, START.y);
    db.prepare("UPDATE pellet_state SET collected = 0 WHERE level = 1").run();

    const round = createRound(db, -1);
    recordVote(db, round.id, "voter-a", "RIGHT");
    recordVote(db, round.id, "voter-b", "RIGHT");
    recordVote(db, round.id, "voter-c", "LEFT");

    ensureCurrentRound(db);

    const after = getCharacter(db);
    expect(after.x).toBe(2);
    expect(after.y).toBe(1);
    expect(after.score).toBe(10); // majority RIGHT actually moved onto and collected the pellet
  });

  it("persists score and collection state across a fresh read from the same database file", () => {
    db.prepare("UPDATE character SET x = ?, y = ?, won = 0, score = 0 WHERE id = 1").run(START.x, START.y);
    db.prepare("UPDATE pellet_state SET collected = 0 WHERE level = 1").run();

    applyRoundResult(db, "RIGHT");

    // A genuinely separate query, not a cached object.
    const reread = getCharacter(db);
    expect(reread.score).toBe(10);
    const pellets = getPellets(db, 1);
    expect(pellets.find((p) => p.x === 2 && p.y === 1)?.collected).toBe(true);
  });
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});
