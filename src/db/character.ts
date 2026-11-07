import type Database from "better-sqlite3";
import type { RoundResult } from "./rounds.ts";
import { collectPelletAt, PELLET_POINTS } from "./pellets.ts";
import { getEnemies, moveLevelEnemies } from "./enemies.ts";
import { detectCollision } from "../game/enemies.ts";
import type { Direction, Point } from "../game/maze.ts";
import { LEVEL_COUNT, isWalkableInLevel, isExitOfLevel, stepInLevel, startOfLevel } from "../game/levels.ts";

export const COLLISION_PENALTY = 20;

export interface Character {
  id: 1;
  x: number;
  y: number;
  won: boolean;
  level: number;
  score: number;
  updated_at: string;
}

interface CharacterRow {
  id: 1;
  x: number;
  y: number;
  won: number;
  level: number;
  score: number;
  updated_at: string;
}

function fromRow(row: CharacterRow): Character {
  return {
    id: row.id,
    x: row.x,
    y: row.y,
    won: row.won === 1,
    level: row.level,
    score: row.score,
    updated_at: row.updated_at,
  };
}

// getDb() guarantees row id=1 exists, so a missing row means it wasn't
// opened through getDb() — surface that loudly rather than returning undefined.
export function getCharacter(db: Database.Database): Character {
  const row = db.prepare("SELECT * FROM character WHERE id = 1").get() as CharacterRow | undefined;
  if (!row) throw new Error("character row missing — was the db opened via getDb()?");
  return fromRow(row);
}

export interface RoundOutcome {
  character: Character;
  collided: boolean;
  advancedLevel: boolean;
}

// Moves the character exactly one tile in the winning direction within its
// *current* level's geometry, moves every enemy belonging to that level one
// random tile, resolves any collision between them, collects a pellet on
// arrival if the character actually moved onto an uncollected one, awards
// its points, and — on reaching that level's EXIT with no collision —
// either advances to the next level's START (levels 1-9) or sets final
// victory (level 10). All inside one transaction, so a crash partway
// through (character moved but enemies not yet, or a collision applied but
// the round not yet closed out by the caller) can never happen: everything
// here commits together or none of it does. better-sqlite3 transactions
// nest via SAVEPOINTs, so this composes correctly whether called standalone
// (e.g. a test) or, as in normal operation, from inside resolveRound's or
// restartGame's own outer transaction (src/game/lifecycle.ts) — either way,
// a later failure anywhere in the outer transaction rolls this back too.
//
// Enemy movement happens on every call that reaches this function with a
// level that has enemies, *regardless* of the vote result — TIE, a
// zero-vote round (which resolves to TIE, same as any other empty round),
// and a wall-blocked player direction all still move enemies, because the
// requirement is "one enemy move per resolved voting round," not "one move
// per player move." The one case enemies do NOT move is when the character
// is already `won` (final victory is frozen, nothing resolves further until
// a restart) or — the level-transition rule — the round in which the
// character's own move happens to land it on a level's EXIT: the new
// level's enemies stay at spawn for that one round, and only the following
// resolved round begins moving them, exactly as specified.
//
// Collision is checked after both the player's and every enemy's final
// position for this round are known, comparing against each enemy's
// *before* position too (src/game/enemies.ts's detectCollision) — this is
// what catches a position swap, not just a direct final-tile overlap. A
// collision found there overrides any level transition: even if the
// player's own move this round would otherwise have landed it on EXIT, a
// simultaneous collision sends it back to the current level's START
// instead, with the pellet-collection and level-advance branches skipped
// entirely for this round. At most one penalty is ever applied regardless
// of how many enemies are individually implicated — detectCollision reports
// only whether a collision occurred, not how many, so there is nothing here
// that could apply it more than once.
export function applyRoundResult(db: Database.Database, result: RoundResult, rng: () => number = Math.random): Character {
  return applyRoundResultDetailed(db, result, rng).character;
}

// Same as applyRoundResult, but also reports whether a collision or a level
// advance happened this round — used by src/game/lifecycle.ts's logging,
// which needs to say so without re-deriving it unreliably from a score or
// position delta (a collision's -20 penalty can coincide with, or be masked
// by, an unrelated +10 pellet pickup's own delta in the same before/after
// comparison, and score floored at 0 makes a pure before/after score
// comparison lossy right at the floor).
export function applyRoundResultDetailed(
  db: Database.Database,
  result: RoundResult,
  rng: () => number = Math.random,
): RoundOutcome {
  let collided = false;
  let advancedLevel = false;

  const move = db.transaction((): void => {
    const before = getCharacter(db);
    if (before.won) return; // final victory freezes everything, including enemies

    const level = before.level;
    const now = new Date().toISOString();

    // Candidate next position: unchanged on TIE or a wall-blocked direction
    // (same no-op rule as before enemies existed), otherwise one tile in the
    // voted direction.
    let candidate: Point = { x: before.x, y: before.y };
    if (result !== "TIE") {
      const next = stepInLevel({ x: before.x, y: before.y }, result as Direction);
      if (isWalkableInLevel(level, next.x, next.y)) candidate = next;
    }
    const reachedExit = isExitOfLevel(level, candidate) && (candidate.x !== before.x || candidate.y !== before.y);

    // Enemies move every resolved round except the one in which the
    // character lands on EXIT (that level's enemies, old or new, stay at
    // spawn for this transition round — movement begins the following
    // resolved round) — this is the one case enemy movement is skipped for
    // a reason other than `won`. They chase `before` — the character's
    // position at the start of this round, not `candidate` — so an enemy's
    // decision can never depend on a player move that hasn't happened yet.
    const enemyMoves = reachedExit ? [] : moveLevelEnemies(db, level, before, rng);
    const enemiesBefore = enemyMoves.map((m) => m.before);
    const enemiesAfter = enemyMoves.length > 0 ? enemyMoves.map((m) => m.after) : getEnemies(db, level);

    collided = detectCollision(
      { x: before.x, y: before.y },
      candidate,
      enemiesBefore.length > 0 ? enemiesBefore : enemiesAfter,
      enemiesAfter,
    );

    if (collided) {
      // Collision overrides everything else this round: no pellet pickup,
      // no level transition, even if `candidate` happened to be EXIT or a
      // pellet tile — the character never actually arrives there. Already
      // collected pellets are untouched (collectPelletAt is simply never
      // called), and the penalty floors at zero via SQL MAX rather than a
      // read-then-write race, so two concurrent resolutions could never
      // drive it negative even in a hypothetical multi-process deployment.
      const start = startOfLevel(level);
      db.prepare("UPDATE character SET x = ?, y = ?, score = MAX(0, score - ?), updated_at = ? WHERE id = 1").run(
        start.x,
        start.y,
        COLLISION_PENALTY,
        now,
      );
      return;
    }

    if (reachedExit) {
      advancedLevel = true;
      if (level < LEVEL_COUNT) {
        // Advance to the next level's START — score and every level's
        // collected-pellet state (pellet_state is keyed by level, untouched
        // here) carry forward unchanged; only position and level move. The
        // new level's enemies were left at spawn above (enemyMoves is empty
        // on this branch), satisfying "do not move enemies in the
        // transition round."
        const nextStart = startOfLevel(level + 1);
        db.prepare("UPDATE character SET x = ?, y = ?, level = ?, updated_at = ? WHERE id = 1").run(
          nextStart.x,
          nextStart.y,
          level + 1,
          now,
        );
      } else {
        // Level 10's EXIT: final victory. Position stays at level 10's
        // EXIT tile (there is no "next level" to move to), won is set —
        // this freezes enemy movement from the next round onward, since
        // every future call returns immediately on `before.won`.
        db.prepare("UPDATE character SET x = ?, y = ?, won = 1, updated_at = ? WHERE id = 1").run(
          candidate.x,
          candidate.y,
          now,
        );
      }
      // No pellet is ever placed on an EXIT tile (spec/levels.test.ts
      // enforces this for every level), so there is nothing to collect on
      // this branch — deliberately skipping collectPelletAt here rather
      // than calling it and relying on it finding nothing.
      return;
    }

    const playerMoved = candidate.x !== before.x || candidate.y !== before.y;
    if (playerMoved) {
      // Only written when the player actually moved — a TIE or a
      // wall-blocked direction leaves the character row completely
      // untouched (not even updated_at), the same no-op guarantee the
      // pre-enemy version of this function made and several tests still
      // check via a full before/after equality comparison.
      db.prepare("UPDATE character SET x = ?, y = ?, updated_at = ? WHERE id = 1").run(candidate.x, candidate.y, now);

      // collectPelletAt's own UPDATE ... WHERE collected = 0 guard is what
      // prevents double-scoring: a tile with no pellet, or one already
      // collected (by an earlier visit), returns false here and nothing is
      // added to score. There is no separate "has this been awarded" check
      // needed beyond that one guarded UPDATE.
      if (collectPelletAt(db, level, candidate.x, candidate.y)) {
        db.prepare("UPDATE character SET score = score + ? WHERE id = 1").run(PELLET_POINTS);
      }
    }
  });
  move();

  return { character: getCharacter(db), collided, advancedLevel };
}

// Resets the character to level 1's START, clears `won`, and zeroes score —
// a full new run, not just an in-level reset. Called only from
// game/lifecycle.ts's restartGame, inside that function's own transaction
// alongside resetting all pellets/enemies, closing out the won round, and
// opening a fresh one, so a crash partway through can't leave the game in a
// half-reset state — everything commits together or none of it does.
export function resetCharacter(db: Database.Database): Character {
  const start = startOfLevel(1);
  db.prepare("UPDATE character SET x = ?, y = ?, won = 0, level = 1, score = 0, updated_at = ? WHERE id = 1").run(
    start.x,
    start.y,
    new Date().toISOString(),
  );
  return getCharacter(db);
}
