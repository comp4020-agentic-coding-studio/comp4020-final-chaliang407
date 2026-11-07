import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// In-process against its own throwaway SQLite file, same pattern as
// spec/movement.test.ts and spec/pellets.test.ts: ten-level progression,
// final victory, and Restart Game are properties of the DB/game-logic layer
// itself (src/db/character.ts's applyRoundResult, src/game/lifecycle.ts's
// restartGame), so calling the exact same production functions src/api.ts
// calls is a faithful, fast check of the real code path. Driving all ten
// levels' shortest routes through real 3-second HTTP rounds (as
// spec/realtime.test.ts does for a single level transition) would take tens
// of minutes of wall-clock time for no extra confidence — this file's own
// header comment in spec/realtime.test.ts documents that scope split
// explicitly.
const dataDir = mkdtempSync(join(tmpdir(), "level-progression-"));
process.env.DATA_DIR = dataDir;

const { getDb } = await import("../src/db/client.ts");
const { getCharacter, applyRoundResult, resetCharacter } = await import("../src/db/character.ts");
const { getPellets, resetAllPellets } = await import("../src/db/pellets.ts");
const { getEnemies, resetAllEnemiesToSpawn } = await import("../src/db/enemies.ts");
const { getRound, createRound } = await import("../src/db/rounds.ts");
const { recordVote, getVotes } = await import("../src/db/votes.ts");
const { ensureCurrentRound, restartGame, RestartNotAllowedError } = await import("../src/game/lifecycle.ts");
const { LEVELS, LEVEL_COUNT, getLevel, isWalkableInLevel, stepInLevel } = await import("../src/game/levels.ts");

type Direction = "UP" | "DOWN" | "LEFT" | "RIGHT";
const ALL_DIRECTIONS: readonly Direction[] = ["UP", "DOWN", "LEFT", "RIGHT"];

// BFS shortest path within one level, from `from` to that level's own EXIT —
// used to drive the character all the way through a level without manually
// transcribing each level's route by hand. Unlike spec/realtime.test.ts's
// own shortestPathTo (which must avoid cutting through EXIT when EXIT isn't
// the destination, since that test drives real HTTP rounds where an
// in-between EXIT crossing would really trigger a transition), this one's
// destination always IS the exit, so the EXIT-avoidance isn't needed here —
// though reaching it is, of course, exactly the point.
function shortestPathToExit(level: number, from?: { x: number; y: number }): Direction[] {
  const def = getLevel(level);
  const start = from ?? def.maze.start;
  const exit = def.maze.exit;
  const key = (p: { x: number; y: number }) => `${p.x},${p.y}`;
  const cameFrom = new Map<string, { from: { x: number; y: number }; dir: Direction }>();
  const visited = new Set<string>([key(start)]);
  const queue: { x: number; y: number }[] = [start];
  while (queue.length) {
    const p = queue.shift()!;
    if (p.x === exit.x && p.y === exit.y) break;
    for (const dir of ALL_DIRECTIONS) {
      const n = stepInLevel(p, dir);
      if (isWalkableInLevel(level, n.x, n.y) && !visited.has(key(n))) {
        visited.add(key(n));
        cameFrom.set(key(n), { from: p, dir });
        queue.push(n);
      }
    }
  }
  if (!visited.has(key(exit))) throw new Error(`level ${level}: no path from START to EXIT`);
  const path: Direction[] = [];
  let cur = exit;
  while (key(cur) !== key(start)) {
    const info = cameFrom.get(key(cur))!;
    path.unshift(info.dir);
    cur = info.from;
  }
  return path;
}

// A small, deterministic PRNG (mulberry32) seeded per level, used in place
// of Math.random() for the level-advance tests below. Levels 3+ move real
// enemies on every resolved round (Milestone 5), so walking a level's full
// shortest route with genuine randomness can legitimately collide partway —
// correct game behaviour, but it turns "does reaching EXIT advance the
// level" into a flaky test for a reason unrelated to what it's checking.
// Each seed here was found offline by brute-force search (trying seeds in
// order against this exact maze/enemy-spawn data until one produced a
// collision-free walk along the level's own shortest route) and verified
// once more at test time below — never trusted blindly — so this is
// "controlled randomness," not "collision avoidance hardcoded into
// production," and spec/collision.test.ts's own deterministic-rng tests
// still own actually proving collision mechanics work.
function mulberry32(seed: number): () => number {
  let s = seed;
  return function (): number {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Seed per level (1-indexed; level 1-2 have no enemies, so any seed works
// there — included for completeness), verified offline to produce a
// collision-free enemy pattern along that level's own shortest route.
// Re-derived for the hybrid chase/patrol AI (src/game/enemies.ts's
// moveEnemyTowardPlayer): a seed that was collision-free under pure-random
// movement has no guarantee of staying collision-free once enemies actively
// close distance toward the player 70% of the time, so these are a fresh
// brute-force search against the real production rng-consumption contract,
// not the old pre-chase values carried forward.
const COLLISION_FREE_SEED: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 1, 5: 28, 6: 5633, 7: 1, 8: 4, 9: 79, 10: 3 };

function resetToLevel1Start(db: ReturnType<typeof getDb>): void {
  const start = getLevel(1).maze.start;
  db.prepare("UPDATE character SET x = ?, y = ?, won = 0, level = 1, score = 0, updated_at = ? WHERE id = 1").run(
    start.x,
    start.y,
    new Date().toISOString(),
  );
  resetAllPellets(db);
  resetAllEnemiesToSpawn(db);
}

describe("level progression", () => {
  const db = getDb();

  it("advances from level 1 to level 2 on reaching level 1's EXIT, moving to level 2's START", () => {
    resetToLevel1Start(db);
    const path = shortestPathToExit(1);

    let last = getCharacter(db);
    for (const direction of path) {
      last = applyRoundResult(db, direction);
    }

    expect(last.level).toBe(2);
    expect(last.won).toBe(false);
    const level2Start = getLevel(2).maze.start;
    expect(last.x).toBe(level2Start.x);
    expect(last.y).toBe(level2Start.y);
  });

  it.each([2, 3, 4, 5, 6, 7, 8, 9])("advances from level %i to the next level on reaching its EXIT", (level) => {
    resetToLevel1Start(db);
    db.prepare("UPDATE character SET level = ? WHERE id = 1").run(level);
    const start = getLevel(level).maze.start;
    db.prepare("UPDATE character SET x = ?, y = ? WHERE id = 1").run(start.x, start.y);

    // A fixed, offline-verified collision-free seed (see COLLISION_FREE_SEED's
    // own comment) in place of Math.random(): levels with enemies (3+) move
    // them on every resolved round, and a long walk under genuine randomness
    // can legitimately collide partway — correct game behaviour, but it
    // makes this test about "does reaching EXIT advance the level" flaky for
    // a reason unrelated to what it's checking. Collision mechanics
    // themselves are covered directly, with their own deterministic rng, by
    // spec/collision.test.ts.
    const rng = mulberry32(COLLISION_FREE_SEED[level]);
    const path = shortestPathToExit(level);
    let last = getCharacter(db);
    for (const direction of path) {
      last = applyRoundResult(db, direction, rng);
    }

    expect(last.level).toBe(level + 1);
    expect(last.won).toBe(false);
    const nextStart = getLevel(level + 1).maze.start;
    expect(last.x).toBe(nextStart.x);
    expect(last.y).toBe(nextStart.y);
  });

  it("sets won=true and stays on level 10 when reaching level 10's EXIT, rather than advancing to a level 11", () => {
    resetToLevel1Start(db);
    db.prepare("UPDATE character SET level = 10 WHERE id = 1").run();
    const start = getLevel(10).maze.start;
    db.prepare("UPDATE character SET x = ?, y = ? WHERE id = 1").run(start.x, start.y);

    const rng = mulberry32(COLLISION_FREE_SEED[10]);
    const path = shortestPathToExit(10);
    let last = getCharacter(db);
    for (const direction of path) {
      last = applyRoundResult(db, direction, rng);
    }

    expect(last.won).toBe(true);
    expect(last.level).toBe(10); // unchanged — no level 11 exists
    const exit = getLevel(10).maze.exit;
    expect(last.x).toBe(exit.x);
    expect(last.y).toBe(exit.y);
  });

  it("does not show final victory before level 10 is completed: won stays false through every level-1-9 transition", () => {
    resetToLevel1Start(db);
    let last = getCharacter(db);
    for (let level = 1; level <= 9; level++) {
      // Same deterministic, offline-verified collision-free seed per level
      // as the level-advance test above — no retry loop needed.
      const rng = mulberry32(COLLISION_FREE_SEED[level]);
      const path = shortestPathToExit(level, last);
      for (const direction of path) {
        last = applyRoundResult(db, direction, rng);
        expect(last.won).toBe(false);
      }
      expect(last.level).toBe(level + 1);
    }
  });

  it("preserves cumulative score across level transitions", () => {
    resetToLevel1Start(db);
    // Collect level 1's pellet at (2,1) first (reachable via RIGHT from
    // START), before continuing on to EXIT — whose own shortest route
    // separately crosses a second level-1 pellet at (1,4), so the expected
    // total below is 2 pellets' worth, not 1; verified against the actual
    // route computed by shortestPathToExit, not assumed.
    let last = applyRoundResult(db, "RIGHT"); // (1,1) -> (2,1), pellet #1
    expect(last.score).toBe(10);
    last = applyRoundResult(db, "LEFT"); // back to (1,1)
    expect(last.score).toBe(10);

    const path = shortestPathToExit(1);
    // Recompute how many of level 1's pellet spawns this specific route
    // actually passes over, rather than hardcoding a number that would
    // silently drift if the maze or pellet spawns ever changed.
    const level1 = getLevel(1);
    let pos = { x: 1, y: 1 };
    let pelletsOnRoute = 0;
    for (const direction of path) {
      pos = stepInLevel(pos, direction);
      if (level1.pelletSpawns.some((p) => p.x === pos.x && p.y === pos.y)) pelletsOnRoute++;
    }

    for (const direction of path) {
      last = applyRoundResult(db, direction);
    }

    expect(last.level).toBe(2);
    expect(last.score).toBe(10 + pelletsOnRoute * 10); // the level 1 pellets' score survives the transition
  });

  it("keeps each level's collected-pellet state intact while progressing to the next level", () => {
    resetToLevel1Start(db);
    applyRoundResult(db, "RIGHT"); // collect level 1's pellet at (2,1)
    applyRoundResult(db, "LEFT");

    const path = shortestPathToExit(1);
    let last = getCharacter(db);
    for (const direction of path) {
      last = applyRoundResult(db, direction);
    }
    expect(last.level).toBe(2);

    // Level 1's pellet state is untouched by progressing to level 2 — still
    // collected, not reset, even though the character has left that level.
    const level1Pellets = getPellets(db, 1);
    const collectedPellet = level1Pellets.find((p) => p.x === 2 && p.y === 1);
    expect(collectedPellet?.collected).toBe(true);

    // And level 2's own pellets are freshly uncollected, not somehow
    // inheriting level 1's collection state.
    const level2Pellets = getPellets(db, 2);
    expect(level2Pellets.every((p) => !p.collected)).toBe(true);
  });

  it("uses the correct maze geometry for the current level in movement and wall-collision checks", () => {
    resetToLevel1Start(db);
    db.prepare("UPDATE character SET level = 2 WHERE id = 1").run();
    const level2Start = getLevel(2).maze.start;
    db.prepare("UPDATE character SET x = ?, y = ? WHERE id = 1").run(level2Start.x, level2Start.y);

    // A direction that's a wall in level 2 from its own START (verified
    // against level 2's own grid: "#.#.....#" row 1 means (0,1) is a wall,
    // so LEFT from (1,1) is blocked) must be a no-op, proving movement reads
    // level 2's geometry, not level 1's (where the equivalent cell might
    // behave differently).
    expect(isWalkableInLevel(2, level2Start.x - 1, level2Start.y)).toBe(false);
    const before = getCharacter(db);
    const after = applyRoundResult(db, "LEFT");
    expect(after).toEqual(before); // blocked, untouched — level 2's own wall, correctly consulted
  });
});

describe("restart game across the ten-level run", () => {
  const db = getDb();

  function winLevel10(): void {
    resetToLevel1Start(db);
    db.prepare("UPDATE character SET level = 10, score = 50 WHERE id = 1").run();
    const start = getLevel(10).maze.start;
    db.prepare("UPDATE character SET x = ?, y = ? WHERE id = 1").run(start.x, start.y);
    // Same offline-verified collision-free seed as the level-advance test
    // above, for the same reason: level 10 has chase-biased enemies, so a
    // genuinely random walk to EXIT can legitimately collide partway, which
    // would make every test built on this helper flaky for a reason
    // unrelated to what each is actually checking (restart behaviour).
    const rng = mulberry32(COLLISION_FREE_SEED[10]);
    const path = shortestPathToExit(10);
    for (const direction of path) applyRoundResult(db, direction, rng);
    expect(getCharacter(db).won).toBe(true);
  }

  it("rejects restart before final victory on level 10, even mid-run on an earlier level", () => {
    resetToLevel1Start(db);
    db.prepare("UPDATE character SET level = 5, x = ?, y = ?, won = 0 WHERE id = 1").run(
      getLevel(5).maze.start.x,
      getLevel(5).maze.start.y,
    );
    expect(() => restartGame(db, "voter-early-restart-l4")).toThrow(RestartNotAllowedError);

    const unchanged = getCharacter(db);
    expect(unchanged.level).toBe(5);
    expect(unchanged.won).toBe(false);
  });

  it("resets level to 1, score to 0, and position to level 1's START after final victory", () => {
    winLevel10();

    const { round } = restartGame(db, "voter-restart-full-1");

    const after = getCharacter(db);
    const level1Start = getLevel(1).maze.start;
    expect(after.level).toBe(1);
    expect(after.score).toBe(0);
    expect(after.x).toBe(level1Start.x);
    expect(after.y).toBe(level1Start.y);
    expect(after.won).toBe(false);
    expect(round.status).toBe("open");
  });

  it("restores all pellets across all ten levels to uncollected", () => {
    resetToLevel1Start(db);
    // Collect at least one pellet on several different levels before the win,
    // so there's something real for restart to actually undo.
    for (const level of [1, 3, 5]) {
      db.prepare("UPDATE character SET level = ?, won = 0 WHERE id = 1").run(level);
      const start = getLevel(level).maze.start;
      db.prepare("UPDATE character SET x = ?, y = ? WHERE id = 1").run(start.x, start.y);
      const spawn = getLevel(level).pelletSpawns[0];
      const path = (function bfsTo(target: { x: number; y: number }) {
        const key = (p: { x: number; y: number }) => `${p.x},${p.y}`;
        const cameFrom = new Map<string, { from: { x: number; y: number }; dir: Direction }>();
        const visited = new Set<string>([key(start)]);
        const queue: { x: number; y: number }[] = [start];
        while (queue.length) {
          const p = queue.shift()!;
          if (p.x === target.x && p.y === target.y) break;
          for (const dir of ALL_DIRECTIONS) {
            const n = stepInLevel(p, dir);
            if (isWalkableInLevel(level, n.x, n.y) && !visited.has(key(n))) {
              visited.add(key(n));
              cameFrom.set(key(n), { from: p, dir });
              queue.push(n);
            }
          }
        }
        const result: Direction[] = [];
        let cur = target;
        while (key(cur) !== key(start)) {
          const info = cameFrom.get(key(cur))!;
          result.unshift(info.dir);
          cur = info.from;
        }
        return result;
      })(spawn);
      for (const direction of path) applyRoundResult(db, direction);
      expect(getPellets(db, level).find((p) => p.x === spawn.x && p.y === spawn.y)?.collected).toBe(true);
    }

    winLevel10();
    restartGame(db, "voter-restart-pellets");

    for (const def of LEVELS) {
      const pellets = getPellets(db, def.level);
      expect(pellets.every((p) => !p.collected), `level ${def.level} should have no collected pellets after restart`).toBe(
        true,
      );
    }
  });

  it("restores all enemies to their fixed initial spawn positions (no enemy movement exists yet to have moved them)", () => {
    // Simulate what a future movement milestone would do to an enemy's
    // position, to prove restart actually restores it rather than it just
    // happening to already be at spawn.
    db.prepare("UPDATE enemies SET x = 99, y = 99 WHERE level = 3 AND index_in_level = 0").run();
    db.prepare("UPDATE enemies SET x = 1, y = 1 WHERE level = 7 AND index_in_level = 1").run();

    winLevel10();
    restartGame(db, "voter-restart-enemies");

    for (const def of LEVELS) {
      const enemies = getEnemies(db, def.level);
      enemies.forEach((e, i) => {
        expect(e).toMatchObject({ x: def.enemySpawns[i].x, y: def.enemySpawns[i].y });
      });
    }
  });

  it("preserves historical rounds and votes through a restart that happened mid-run", () => {
    resetToLevel1Start(db);
    const round = createRound(db, -1);
    recordVote(db, round.id, "voter-history-progression-a", "RIGHT");
    recordVote(db, round.id, "voter-history-progression-b", "RIGHT");
    ensureCurrentRound(db); // resolve it into history

    const roundsBefore = db.prepare("SELECT COUNT(*) as n FROM rounds").get() as { n: number };
    const votesBefore = db.prepare("SELECT COUNT(*) as n FROM votes").get() as { n: number };

    winLevel10();
    restartGame(db, "voter-restart-history");

    const roundsAfter = db.prepare("SELECT COUNT(*) as n FROM rounds").get() as { n: number };
    const votesAfter = db.prepare("SELECT COUNT(*) as n FROM votes").get() as { n: number };
    // Restart only ever adds rounds (closing the pre-restart one, opening a
    // fresh one) — it never deletes history, so counts only grow.
    expect(roundsAfter.n).toBeGreaterThanOrEqual(roundsBefore.n);
    expect(votesAfter.n).toBe(votesBefore.n); // no vote is ever deleted by a restart

    const historicalVotes = getVotes(db, round.id);
    expect(historicalVotes.map((v) => v.voter_id).sort()).toEqual(
      ["voter-history-progression-a", "voter-history-progression-b"].sort(),
    );
    const historicalRound = getRound(db, round.id)!;
    expect(historicalRound.status).toBe("resolved");
  });

  it("performs the entire restart atomically: character, pellets, and enemies all reset together or not at all", () => {
    winLevel10();
    db.prepare("UPDATE pellet_state SET collected = 1 WHERE level = 1 AND x = 2 AND y = 1").run();
    db.prepare("UPDATE enemies SET x = 50, y = 50 WHERE level = 5 AND index_in_level = 0").run();

    const before = getCharacter(db);

    // Force the outer transaction restartGame's own call would be wrapped in
    // (if it were) to fail after restartGame's own transaction commits, to
    // prove restartGame's internal atomicity doesn't depend on an outer
    // caller — restartGame commits its own single transaction regardless.
    restartGame(db, "voter-atomic-restart");

    const after = getCharacter(db);
    expect(after.level).toBe(1);
    expect(after.score).toBe(0);
    expect(after.won).toBe(false);
    expect(after).not.toEqual(before);

    const pellet = getPellets(db, 1).find((p) => p.x === 2 && p.y === 1);
    expect(pellet?.collected).toBe(false); // reset together with the character, not left behind

    const enemy = getEnemies(db, 5)[0];
    expect(enemy).toMatchObject({ x: getLevel(5).enemySpawns[0].x, y: getLevel(5).enemySpawns[0].y });
  });

  it("serializes concurrent restart requests so only the first actually restarts (no double run, no corruption)", () => {
    // better-sqlite3 transactions are synchronous with no interleaving
    // `await` inside them, so calling restartGame twice back to back from
    // the same synchronous context is the faithful in-process equivalent of
    // two requests racing: the second call can only begin once the first
    // call's entire transaction (including its own fresh character.won
    // read) has already committed, never during it.
    winLevel10();
    const roundsBefore = (db.prepare("SELECT COUNT(*) as n FROM rounds WHERE status = 'open'").get() as {
      n: number;
    }).n;

    const first = restartGame(db, "voter-concurrent-full-a");
    let secondError: unknown;
    try {
      restartGame(db, "voter-concurrent-full-b");
    } catch (err) {
      secondError = err;
    }

    expect(secondError).toBeInstanceOf(RestartNotAllowedError);
    const after = getCharacter(db);
    expect(after.level).toBe(1);
    expect(after.score).toBe(0);
    expect(first.round.status).toBe("open");

    // The rejected second call must not have created a competing round of
    // its own: the number of open rounds changes by at most the one
    // restartGame's own close-then-create always does (closing whatever was
    // open, opening exactly one fresh one), never by two.
    const roundsAfter = (db.prepare("SELECT COUNT(*) as n FROM rounds WHERE status = 'open'").get() as {
      n: number;
    }).n;
    expect(roundsAfter).toBeLessThanOrEqual(roundsBefore + 1);
  });

  it("never lets a stale pre-restart round's own resolution affect the new level-1 run", () => {
    // The closed-out round can "decide" any result, including a direction
    // that would normally move the character — but because it's resolved
    // and applied *before* the reset (while character.won is still true on
    // level 10), applyRoundResult's victory-is-sticky rule makes that a
    // no-op, and the reset that follows is unconditional.
    resetToLevel1Start(db);
    db.prepare("UPDATE character SET level = 10, score = 30 WHERE id = 1").run();
    const start = getLevel(10).maze.start;
    db.prepare("UPDATE character SET x = ?, y = ? WHERE id = 1").run(start.x, start.y);
    const rng = mulberry32(COLLISION_FREE_SEED[10]);
    const path = shortestPathToExit(10);
    for (const direction of path) applyRoundResult(db, direction, rng);
    expect(getCharacter(db).won).toBe(true);

    const openRound = ensureCurrentRound(db);
    recordVote(db, openRound.id, "voter-stale-progression-a", "LEFT");
    recordVote(db, openRound.id, "voter-stale-progression-b", "LEFT");

    restartGame(db, "voter-restart-stale-timer");

    const after = getCharacter(db);
    const level1Start = getLevel(1).maze.start;
    expect(after.level).toBe(1);
    expect(after.x).toBe(level1Start.x);
    expect(after.y).toBe(level1Start.y);
    expect(after.won).toBe(false);
  });
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});
