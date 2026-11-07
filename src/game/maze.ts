export type Direction = "UP" | "DOWN" | "LEFT" | "RIGHT";

export interface Point {
  x: number;
  y: number;
}

// A fixed, hand-designed 2D maze: each row is a string of '#' (wall) or '.'
// (floor). Cell-based rather than wall-segment-based — simpler to store,
// render, and test — but still has real structure: a connected graph with
// intersections (degree >= 3), dead ends (degree 1), and a genuine cycle (the
// outer ring), not a spanning-tree "perfect maze" with exactly one route.
// START and EXIT are ordinary floor cells, named separately rather than with
// their own grid characters, so they behave like any other walkable cell
// everywhere except the win check.
const ROWS: readonly string[] = [
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

export const MAZE_WIDTH = ROWS[0].length;
export const MAZE_HEIGHT = ROWS.length;
export const START: Point = { x: 1, y: 1 };
export const EXIT: Point = { x: 7, y: 7 };

const DELTAS: Record<Direction, Point> = {
  UP: { x: 0, y: -1 },
  DOWN: { x: 0, y: 1 },
  LEFT: { x: -1, y: 0 },
  RIGHT: { x: 1, y: 0 },
};

export function inBounds(x: number, y: number): boolean {
  return x >= 0 && x < MAZE_WIDTH && y >= 0 && y < MAZE_HEIGHT;
}

// The only function that reads the grid's wall/floor shape. Out-of-bounds is
// treated as a wall, not a separate case, so callers never need their own
// bounds check before this one.
export function isWalkable(x: number, y: number): boolean {
  return inBounds(x, y) && ROWS[y][x] === ".";
}

export function step(point: Point, direction: Direction): Point {
  const delta = DELTAS[direction];
  return { x: point.x + delta.x, y: point.y + delta.y };
}

export function isExit(point: Point): boolean {
  return point.x === EXIT.x && point.y === EXIT.y;
}

export interface MazeLayout {
  width: number;
  height: number;
  rows: string[];
  start: Point;
  exit: Point;
}

// Static, public, identical for every request — safe to serve once per page
// load from its own endpoint rather than folding into the per-poll
// /api/state payload (src/api.ts's buildStatePayload stays scoped to
// character/round/recentRounds, unchanged).
export function getMazeLayout(): MazeLayout {
  return { width: MAZE_WIDTH, height: MAZE_HEIGHT, rows: [...ROWS], start: START, exit: EXIT };
}

// Every open floor cell, for connectivity/route tests — not used by game
// logic itself (isWalkable is), only by tests that want to reason about the
// maze as a graph.
export function floorCells(): Point[] {
  const cells: Point[] = [];
  for (let y = 0; y < MAZE_HEIGHT; y++) {
    for (let x = 0; x < MAZE_WIDTH; x++) {
      if (isWalkable(x, y)) cells.push({ x, y });
    }
  }
  return cells;
}
