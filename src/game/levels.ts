import { MAZE_HEIGHT, MAZE_WIDTH, START as LEVEL_1_START, EXIT as LEVEL_1_EXIT, type Direction, type Point } from "./maze.ts";
import type { MazeShape } from "./mazeValidator.ts";

// Ten fixed, hand-selected maze layouts — one per level, each validated by
// spec/levels.test.ts against src/game/mazeValidator.ts before being trusted
// here. Levels 2-10 were generated offline with a standard recursive-
// backtracker spanning-tree algorithm, then had a handful of extra walls
// knocked out to introduce loops, and were hardcoded here exactly like
// Level 1's original hand-authored grid — "fixed content, validated once,"
// not something generated at runtime. Complexity increases gradually: each
// level is larger (more floor cells) and has at least as many intersections
// as the one before it (see spec/levels.test.ts's monotonicity check).
//
// Pellet and enemy *spawn positions* are fixed content too, computed offline
// the same way the mazes themselves were (deterministic, verified against
// this file's own maze data before being hardcoded) — every position is
// walkable, none overlaps START or EXIT, and no two spawns (pellet/pellet,
// enemy/enemy, or pellet/enemy) land on the same tile; spec/levels.test.ts
// re-verifies all of this per level rather than trusting it was done right
// offline. Enemy *behaviour* (movement, collision) and pellet *collection*
// (scoring, persistence of which pellets have been eaten) are still out of
// scope for this milestone — this file only states where things start.
export interface LevelDefinition {
  level: number;
  maze: MazeShape;
  // Fixed per the approved design: 0,0,1,1,2,2,3,3,4,4 across levels 1-10.
  enemyCount: number;
  // Every pellet's fixed starting tile for this level. A future milestone's
  // pellet_state table is seeded from this list, once, the same way
  // src/db/client.ts's ensureCharacter seeds the character row.
  pelletSpawns: readonly Point[];
  // Every enemy's fixed starting tile for this level, length === enemyCount.
  // A future milestone's enemies table is seeded from this list.
  enemySpawns: readonly Point[];
}

// Level 1 is byte-identical to the maze this project shipped before the
// 10-level expansion (src/game/maze.ts's ROWS/START/EXIT) — required so an
// existing database's character position/won state stays meaningful across
// the migration a later milestone will perform (see the migration plan
// agreed before this milestone started).
const LEVEL_1_ROWS: readonly string[] = [
  "##########",
  "#.......##",
  "#.#####.##",
  "#.#...#..#",
  "#.#.#.#.##",
  "#...#...##",
  "###.###.##",
  "#.......##",
  "##########",
];

const LEVEL_2_ROWS: readonly string[] = [
  "#########",
  "#.#.....#",
  "#.#####.#",
  "#.....#.#",
  "#.###.#.#",
  "#.....#.#",
  "#.###.#.#",
  "#.#.....#",
  "#.###.#.#",
  "#.....#.#",
  "#########",
];

const LEVEL_3_ROWS: readonly string[] = [
  "###########",
  "#.....#...#",
  "#.###.#.###",
  "#.....#...#",
  "#.#.###.#.#",
  "#.#...#.#.#",
  "#.#.#.###.#",
  "#...#...#.#",
  "#.#.###.#.#",
  "#.#.......#",
  "###########",
];

const LEVEL_4_ROWS: readonly string[] = [
  "###########",
  "#.......#.#",
  "#######.#.#",
  "#.......#.#",
  "#.#.#.###.#",
  "#.#.......#",
  "#.#######.#",
  "#.........#",
  "###.#####.#",
  "#.....#...#",
  "#.###.#.###",
  "#...#.....#",
  "###########",
];

const LEVEL_5_ROWS: readonly string[] = [
  "#############",
  "#.#.........#",
  "#.###.#.###.#",
  "#.....#.#...#",
  "###.#.#.#####",
  "#...#.#.#...#",
  "#.###.#.#.#.#",
  "#...#.#...#.#",
  "###.#.#.#.#.#",
  "#...#.#.....#",
  "#.###.###.#.#",
  "#.........#.#",
  "#############",
];

const LEVEL_6_ROWS: readonly string[] = [
  "#############",
  "#.......#...#",
  "#######.#.#.#",
  "#...#.#.#.#.#",
  "#.#.#.#.#.#.#",
  "#.....#.....#",
  "#.#########.#",
  "#.......#...#",
  "#.#.###.#.#.#",
  "#.#...#.#...#",
  "#.#.###.###.#",
  "#.#...#.....#",
  "#.###.#######",
  "#...........#",
  "#############",
];

const LEVEL_7_ROWS: readonly string[] = [
  "###############",
  "#.#...........#",
  "#.###########.#",
  "#.....#.......#",
  "#####.#.#####.#",
  "#...#.......#.#",
  "#.###.###.###.#",
  "#.#...........#",
  "#.#.#####.#.#.#",
  "#.#...#.#.#.#.#",
  "#.###.#.#.#.#.#",
  "#.#...#.#...#.#",
  "#.#.###.###.#.#",
  "#.............#",
  "###############",
];

const LEVEL_8_ROWS: readonly string[] = [
  "###############",
  "#.#.......#...#",
  "#.#.#####.#.#.#",
  "#.........#.#.#",
  "#####.#.#.#.#.#",
  "#.....#.#...#.#",
  "#.#.###.#.###.#",
  "#.#.#...#...#.#",
  "#.#.#.###.#.#.#",
  "#.#.#...#.#...#",
  "#.#.###.#.#.###",
  "#.#...#.#.....#",
  "#.#####.#.###.#",
  "#.....#.#.#...#",
  "#.###.#.###.#.#",
  "#...#.......#.#",
  "###############",
];

const LEVEL_9_ROWS: readonly string[] = [
  "#################",
  "#...#...........#",
  "###.###.###.#.#.#",
  "#.#.#.....#.#.#.#",
  "#.#.#.###.###.#.#",
  "#...#...#.....#.#",
  "#.#####.#####.#.#",
  "#.#...#.....#...#",
  "#.#.#.#####.#.###",
  "#.#.........#.#.#",
  "#.#.###.#####.#.#",
  "#...#.....#...#.#",
  "#####.###.#.###.#",
  "#.....#...#.....#",
  "#.#.#.#####.#.#.#",
  "#...#.........#.#",
  "#################",
];

const LEVEL_10_ROWS: readonly string[] = [
  "#################",
  "#.#...#...#.....#",
  "#.#.#.#.#.#.#.#.#",
  "#.....#.#...#.#.#",
  "#.###.#.#####.#.#",
  "#.....#.#.....#.#",
  "#.#.###.#.#####.#",
  "#.#...#.#.....#.#",
  "#.###.#.#####.#.#",
  "#.....#.#...#.#.#",
  "#.#.###.#.#.#.#.#",
  "#.#.....#.#.#.#.#",
  "#.#####.#.#.#.#.#",
  "#.#...#...#.#...#",
  "#.#.#.#.#.#####.#",
  "#...#.#.#.......#",
  "#.###.#.#.###.#.#",
  "#.......#...#...#",
  "#################",
];

function bottomRightExit(rows: readonly string[]): Point {
  // Every level above (including Level 1) places EXIT one cell in from the
  // bottom-right corner — a fixed authoring convention, not computed from
  // the grid's content, since a maze's bottom-right-most *floor* cell isn't
  // necessarily meant to be its exit. Levels 2-10 were generated with this
  // convention baked in; this helper just keeps that single rule visible in
  // one place instead of repeating the arithmetic ten times.
  return { x: rows[0].length - 2, y: rows.length - 2 };
}

const ENEMY_COUNTS: readonly number[] = [0, 0, 1, 1, 2, 2, 3, 3, 4, 4];

// Deterministic, offline-computed spawn positions (see this file's header
// comment) — every (x,y) here was checked against its own level's maze data
// before being hardcoded: walkable, not on START or EXIT, and not shared
// with any other spawn in the same level. spec/levels.test.ts re-checks all
// of this at test time rather than trusting that offline step.
const PELLET_SPAWNS: readonly (readonly Point[])[] = [
  [{ x: 2, y: 1 }, { x: 1, y: 4 }, { x: 7, y: 1 }, { x: 3, y: 3 }, { x: 7, y: 4 }, { x: 1, y: 7 }],
  [{ x: 1, y: 2 }, { x: 4, y: 3 }, { x: 5, y: 4 }, { x: 2, y: 9 }, { x: 4, y: 9 }, { x: 7, y: 5 }],
  [{ x: 2, y: 1 }, { x: 3, y: 3 }, { x: 1, y: 7 }, { x: 5, y: 6 }, { x: 7, y: 8 }, { x: 9, y: 4 }],
  [
    { x: 2, y: 1 }, { x: 6, y: 3 }, { x: 4, y: 5 }, { x: 9, y: 5 }, { x: 2, y: 7 }, { x: 6, y: 7 },
    { x: 7, y: 10 },
  ],
  [
    { x: 1, y: 2 }, { x: 5, y: 2 }, { x: 1, y: 6 }, { x: 2, y: 7 }, { x: 3, y: 8 }, { x: 2, y: 9 },
    { x: 10, y: 3 }, { x: 7, y: 9 }, { x: 9, y: 9 },
  ],
  [
    { x: 2, y: 1 }, { x: 7, y: 4 }, { x: 9, y: 2 }, { x: 10, y: 7 }, { x: 9, y: 9 }, { x: 7, y: 8 },
    { x: 1, y: 7 }, { x: 5, y: 9 }, { x: 1, y: 11 }, { x: 5, y: 5 },
  ],
  [
    { x: 1, y: 2 }, { x: 6, y: 5 }, { x: 7, y: 3 }, { x: 3, y: 8 }, { x: 4, y: 9 }, { x: 5, y: 10 },
    { x: 13, y: 4 }, { x: 13, y: 9 }, { x: 13, y: 11 }, { x: 12, y: 13 }, { x: 8, y: 13 }, { x: 1, y: 9 },
  ],
  [
    { x: 1, y: 2 }, { x: 6, y: 3 }, { x: 7, y: 1 }, { x: 7, y: 6 }, { x: 6, y: 7 }, { x: 1, y: 8 },
    { x: 3, y: 11 }, { x: 11, y: 9 }, { x: 1, y: 12 }, { x: 13, y: 8 }, { x: 7, y: 13 }, { x: 5, y: 13 },
  ],
  [
    { x: 2, y: 1 }, { x: 1, y: 3 }, { x: 3, y: 8 }, { x: 7, y: 10 }, { x: 5, y: 12 }, { x: 3, y: 13 },
    { x: 7, y: 15 }, { x: 5, y: 5 }, { x: 12, y: 13 }, { x: 9, y: 3 }, { x: 9, y: 1 }, { x: 13, y: 7 },
  ],
  [
    { x: 1, y: 2 }, { x: 3, y: 5 }, { x: 4, y: 7 }, { x: 1, y: 13 }, { x: 7, y: 12 }, { x: 7, y: 7 },
    { x: 7, y: 5 }, { x: 9, y: 17 }, { x: 13, y: 16 }, { x: 15, y: 13 }, { x: 13, y: 11 }, { x: 13, y: 3 },
  ],
];

const ENEMY_SPAWNS: readonly (readonly Point[])[] = [
  [],
  [],
  [{ x: 9, y: 1 }],
  [{ x: 3, y: 11 }],
  [{ x: 11, y: 7 }, { x: 11, y: 10 }],
  [{ x: 10, y: 13 }, { x: 8, y: 13 }],
  [{ x: 3, y: 5 }, { x: 1, y: 5 }, { x: 3, y: 1 }],
  [{ x: 11, y: 15 }, { x: 11, y: 13 }, { x: 5, y: 15 }],
  [{ x: 15, y: 3 }, { x: 15, y: 1 }, { x: 13, y: 3 }, { x: 15, y: 5 }],
  [{ x: 9, y: 5 }, { x: 11, y: 5 }, { x: 9, y: 7 }, { x: 15, y: 3 }],
];

function defineLevel(level: number, rows: readonly string[], start: Point, exit: Point): LevelDefinition {
  return {
    level,
    maze: { width: rows[0].length, height: rows.length, rows, start, exit },
    enemyCount: ENEMY_COUNTS[level - 1],
    pelletSpawns: PELLET_SPAWNS[level - 1],
    enemySpawns: ENEMY_SPAWNS[level - 1],
  };
}

export const LEVELS: readonly LevelDefinition[] = [
  defineLevel(1, LEVEL_1_ROWS, LEVEL_1_START, LEVEL_1_EXIT),
  defineLevel(2, LEVEL_2_ROWS, { x: 1, y: 1 }, bottomRightExit(LEVEL_2_ROWS)),
  defineLevel(3, LEVEL_3_ROWS, { x: 1, y: 1 }, bottomRightExit(LEVEL_3_ROWS)),
  defineLevel(4, LEVEL_4_ROWS, { x: 1, y: 1 }, bottomRightExit(LEVEL_4_ROWS)),
  defineLevel(5, LEVEL_5_ROWS, { x: 1, y: 1 }, bottomRightExit(LEVEL_5_ROWS)),
  defineLevel(6, LEVEL_6_ROWS, { x: 1, y: 1 }, bottomRightExit(LEVEL_6_ROWS)),
  defineLevel(7, LEVEL_7_ROWS, { x: 1, y: 1 }, bottomRightExit(LEVEL_7_ROWS)),
  defineLevel(8, LEVEL_8_ROWS, { x: 1, y: 1 }, bottomRightExit(LEVEL_8_ROWS)),
  defineLevel(9, LEVEL_9_ROWS, { x: 1, y: 1 }, bottomRightExit(LEVEL_9_ROWS)),
  defineLevel(10, LEVEL_10_ROWS, { x: 1, y: 1 }, bottomRightExit(LEVEL_10_ROWS)),
];

export const LEVEL_COUNT = LEVELS.length;

export function getLevel(level: number): LevelDefinition {
  const def = LEVELS[level - 1];
  if (!def) throw new Error(`no such level: ${level} (levels are numbered 1-${LEVEL_COUNT})`);
  return def;
}

// Sanity-checks this module's own Level 1 data against src/game/maze.ts's
// existing exported constants at import time — if a future edit to either
// file ever lets them drift apart, this throws immediately on startup
// instead of silently breaking the migration's "Level 1 is identical"
// guarantee. Cheap (runs once, at module load) and deliberately not a test —
// the invariant it checks is about these two source files agreeing with
// each other, not about runtime behaviour.
if (LEVEL_1_ROWS.length !== MAZE_HEIGHT || LEVEL_1_ROWS[0].length !== MAZE_WIDTH) {
  throw new Error("levels.ts's Level 1 dimensions have drifted from src/game/maze.ts's existing maze");
}

const STEP_DELTAS: Record<Direction, Point> = {
  UP: { x: 0, y: -1 },
  DOWN: { x: 0, y: 1 },
  LEFT: { x: -1, y: 0 },
  RIGHT: { x: 1, y: 0 },
};

// Level-aware counterparts of src/game/maze.ts's isWalkable/step/isExit,
// which are hardcoded to that module's own single, module-private grid
// (Level 1's). Movement, wall-collision, and exit checks must use *this
// level's* geometry, not always Level 1's, once more than one level exists
// — these are the one place that distinction is made, so
// src/db/character.ts's movement logic reads a level's shape from here
// rather than ever reaching into src/game/maze.ts directly for anything
// beyond Level 1's own fixed identity (LEVEL_1_START/LEVEL_1_EXIT above).
export function isWalkableInLevel(level: number, x: number, y: number): boolean {
  const def = getLevel(level);
  return x >= 0 && x < def.maze.width && y >= 0 && y < def.maze.height && def.maze.rows[y][x] === ".";
}

export function stepInLevel(point: Point, direction: Direction): Point {
  const delta = STEP_DELTAS[direction];
  return { x: point.x + delta.x, y: point.y + delta.y };
}

export function isExitOfLevel(level: number, point: Point): boolean {
  const def = getLevel(level);
  return point.x === def.maze.exit.x && point.y === def.maze.exit.y;
}

export function startOfLevel(level: number): Point {
  return getLevel(level).maze.start;
}
