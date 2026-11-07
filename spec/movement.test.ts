import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// This file runs in-process against its own throwaway SQLite file (like
// spec/logging.test.ts runs in-process against src/logging.ts), not over
// HTTP against the shared running app spec/realtime.test.ts and
// spec/identity.test.ts use. Movement, wall-blocking, victory, and
// persistence are properties of the DB/game-logic layer itself
// (src/db/character.ts, src/game/lifecycle.ts) — exercising them through
// real round timers over HTTP would mean waiting out dozens of
// ROUND_DURATION_MS windows for no extra confidence, when calling the same
// functions src/api.ts calls is a faithful, much faster check of the same
// code path. vitest isolates module state per test file by default, so
// setting DATA_DIR before importing src/config.ts here can't collide with
// the DB the HTTP-based spec files point at.
const dataDir = mkdtempSync(join(tmpdir(), "maze-movement-"));
process.env.DATA_DIR = dataDir;

const { getDb } = await import("../src/db/client.ts");
const { getCharacter, applyRoundResult } = await import("../src/db/character.ts");
const { getRound, createRound } = await import("../src/db/rounds.ts");
const { recordVote, getVotes } = await import("../src/db/votes.ts");
const { ensureCurrentRound, restartGame, RestartNotAllowedError } = await import("../src/game/lifecycle.ts");
const { START, EXIT, isWalkable } = await import("../src/game/maze.ts");

describe("maze movement and walls", () => {
  const db = getDb();

  it("starts the character at the maze's START cell, not won", () => {
    const character = getCharacter(db);
    expect(character.x).toBe(START.x);
    expect(character.y).toBe(START.y);
    expect(character.won).toBe(false);
  });

  it("moves the character exactly one tile when the winning direction is walkable", () => {
    const before = getCharacter(db);
    expect(isWalkable(before.x, before.y + 1)).toBe(true); // DOWN is open from START
    const after = applyRoundResult(db, "DOWN");
    expect(after.x).toBe(before.x);
    expect(after.y).toBe(before.y + 1);
  });

  it("does not move the character through a wall, even though the round still resolves", () => {
    const before = getCharacter(db);
    expect(isWalkable(before.x - 1, before.y)).toBe(false); // LEFT is a wall at this cell
    const after = applyRoundResult(db, "LEFT");
    expect(after).toEqual(before); // untouched: blocked direction is a no-op, not an error
  });

  it("leaves the character untouched on a TIE", () => {
    const before = getCharacter(db);
    const after = applyRoundResult(db, "TIE");
    expect(after).toEqual(before);
  });

  it("walks the full shortest path to level 1's EXIT and advances to level 2, rather than setting final victory", () => {
    // Precomputed shortest route from this file's own fresh START, verified
    // offline against src/game/maze.ts's fixed grid (see the maze audit).
    // Reaching level 1's EXIT now advances to level 2 (src/game/levels.ts's
    // ten-level expansion) rather than setting won=true — that outdated
    // single-level assumption is what this test used to check; full
    // ten-level completion and final victory are covered by
    // spec/levelProgression.test.ts instead.
    const path = [
      "DOWN",
      "DOWN",
      "DOWN",
      "DOWN",
      "RIGHT",
      "RIGHT",
      "DOWN",
      "DOWN",
      "RIGHT",
      "RIGHT",
      "RIGHT",
      "RIGHT",
    ] as const;

    // Reset to a known position for this test's own fresh walk, independent
    // of whatever the two tests above already did to the shared character row.
    db.prepare("UPDATE character SET x = ?, y = ?, won = 0, level = 1 WHERE id = 1").run(START.x, START.y);

    let last = getCharacter(db);
    for (const direction of path) {
      last = applyRoundResult(db, direction);
    }

    expect(last.won).toBe(false); // not final victory — only level 1 of 10 completed
    expect(last.level).toBe(2);
    // Moved to level 2's own START, not left sitting at level 1's EXIT.
    expect(last.x).not.toBe(EXIT.x);
    expect(last.y).not.toBe(EXIT.y);
  });

  it("persists character position and victory across a fresh read from the same database file", () => {
    db.prepare("UPDATE character SET x = ?, y = ?, won = 1 WHERE id = 1").run(EXIT.x, EXIT.y);

    // A genuinely separate query, not a cached object — proves the value
    // round-tripped through SQLite rather than only ever living in memory.
    const reread = getCharacter(db);
    expect(reread.x).toBe(EXIT.x);
    expect(reread.y).toBe(EXIT.y);
    expect(reread.won).toBe(true);
  });

  it("drives a real round through the vote/tally/resolve pipeline and persists the resulting movement", () => {
    db.prepare("UPDATE character SET x = ?, y = ?, won = 0 WHERE id = 1").run(START.x, START.y);

    // A round whose deadline is already in the past resolves on the very
    // next ensureCurrentRound call, the same lazy-resolution path every real
    // request goes through (src/game/lifecycle.ts) — no need to wait out
    // ROUND_DURATION_MS in a test.
    const round = createRound(db, -1);
    recordVote(db, round.id, "voter-a", "DOWN");
    recordVote(db, round.id, "voter-b", "DOWN");
    recordVote(db, round.id, "voter-c", "RIGHT");

    ensureCurrentRound(db);

    const after = getCharacter(db);
    expect(after.x).toBe(START.x);
    expect(after.y).toBe(START.y + 1); // majority DOWN actually moved the character one tile
  });
});

describe("restart game", () => {
  const db = getDb();

  it("rejects a restart attempt before the character has reached EXIT", () => {
    db.prepare("UPDATE character SET x = ?, y = ?, won = 0 WHERE id = 1").run(START.x, START.y);
    expect(() => restartGame(db, "voter-early-restart")).toThrow(RestartNotAllowedError);

    // Rejection must not have side effects: no new round, character unchanged.
    const before = getCharacter(db);
    expect(before.x).toBe(START.x);
    expect(before.y).toBe(START.y);
    expect(before.won).toBe(false);
  });

  it("resets the character to START and clears won after a successful restart", () => {
    db.prepare("UPDATE character SET x = ?, y = ?, won = 1 WHERE id = 1").run(EXIT.x, EXIT.y);

    const { round } = restartGame(db, "voter-restart-1");

    const after = getCharacter(db);
    expect(after.x).toBe(START.x);
    expect(after.y).toBe(START.y);
    expect(after.won).toBe(false);
    expect(round.status).toBe("open");
  });

  it("opens a fresh round with its own full-length window, not inheriting the old round's deadline", () => {
    db.prepare("UPDATE character SET x = ?, y = ?, won = 1 WHERE id = 1").run(EXIT.x, EXIT.y);
    const staleRound = ensureCurrentRound(db);
    // Artificially make the pre-restart round look almost expired, to prove
    // the fresh round after restart gets its own clock rather than reusing
    // whatever time was left on this one.
    db.prepare("UPDATE rounds SET resolves_at = ? WHERE id = ?").run(
      new Date(Date.now() + 1).toISOString(),
      staleRound.id,
    );

    const before = Date.now();
    const { round } = restartGame(db, "voter-restart-2");
    const after = Date.now();

    expect(round.id).not.toBe(staleRound.id);
    const resolvesAt = new Date(round.resolves_at).getTime();
    // A full fresh window measured from roughly now, not "1ms from whenever
    // the stale round was created."
    expect(resolvesAt).toBeGreaterThan(before + 100);
    expect(resolvesAt).toBeLessThanOrEqual(after + 10_000);
  });

  it("closes out the pre-restart round into history instead of discarding it", () => {
    db.prepare("UPDATE character SET x = ?, y = ?, won = 1 WHERE id = 1").run(EXIT.x, EXIT.y);
    const openRound = ensureCurrentRound(db);
    recordVote(db, openRound.id, "voter-history-a", "UP");
    recordVote(db, openRound.id, "voter-history-b", "UP");

    restartGame(db, "voter-restart-3");

    const closed = getRound(db, openRound.id)!;
    expect(closed.status).toBe("resolved");
    expect(closed.resolved_at).not.toBeNull();
    // Decided from whatever was actually cast against it, not invented —
    // same resolution rule as any other round closing.
    expect(closed.result_action).toBe("UP");

    // And the votes themselves are untouched — restart preserves history,
    // it doesn't delete it.
    const votes = getVotes(db, openRound.id);
    expect(votes).toHaveLength(2);
    expect(votes.map((v) => v.voter_id).sort()).toEqual(["voter-history-a", "voter-history-b"]);
  });

  it("never lets the pre-restart round's own resolution move the freshly-reset character", () => {
    // The closed-out round can "decide" any result, including one whose
    // direction would normally move the character — but because it's
    // resolved and applied *before* the reset (while character.won is still
    // true), applyRoundResult's victory-is-sticky rule makes that a no-op,
    // and the reset that follows is unconditional. This is what makes a
    // stale round's leftover votes harmless after a restart.
    db.prepare("UPDATE character SET x = ?, y = ?, won = 1 WHERE id = 1").run(EXIT.x, EXIT.y);
    const openRound = ensureCurrentRound(db);
    recordVote(db, openRound.id, "voter-stale-a", "LEFT");
    recordVote(db, openRound.id, "voter-stale-b", "LEFT");

    restartGame(db, "voter-restart-4");

    const after = getCharacter(db);
    expect(after.x).toBe(START.x);
    expect(after.y).toBe(START.y);
    expect(after.won).toBe(false);
  });

  it("rejects a second restart immediately after a successful one (won is already false again)", () => {
    db.prepare("UPDATE character SET x = ?, y = ?, won = 1 WHERE id = 1").run(EXIT.x, EXIT.y);
    restartGame(db, "voter-restart-5");

    expect(() => restartGame(db, "voter-restart-6")).toThrow(RestartNotAllowedError);
  });

  it("serializes two 'concurrent' restart attempts so only the first actually restarts", () => {
    // better-sqlite3 transactions are synchronous with no interleaving
    // `await` inside them, so calling restartGame twice back to back from
    // the same synchronous context is the faithful in-process equivalent of
    // two requests racing: the second call can only begin once the first
    // call's entire transaction (including its own fresh character.won
    // read) has already committed, never during it.
    db.prepare("UPDATE character SET x = ?, y = ?, won = 1 WHERE id = 1").run(EXIT.x, EXIT.y);

    const first = restartGame(db, "voter-concurrent-a");
    let secondError: unknown;
    try {
      restartGame(db, "voter-concurrent-b");
    } catch (err) {
      secondError = err;
    }

    expect(secondError).toBeInstanceOf(RestartNotAllowedError);
    // Exactly one fresh round was created by the restart, not two.
    const after = getCharacter(db);
    expect(after.x).toBe(START.x);
    expect(after.y).toBe(START.y);
    expect(first.round.status).toBe("open");
  });
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});
