import type { Point } from "./maze.ts";

// A generic maze shape to validate — deliberately not tied to src/game/maze.ts's
// module-private ROWS, so this same validator can check any of the ten level
// layouts in src/game/levels.ts (or, in principle, the original single maze)
// without any of them needing to go through a shared runtime singleton.
export interface MazeShape {
  width: number;
  height: number;
  rows: readonly string[];
  start: Point;
  exit: Point;
}

export interface MazeValidationResult {
  valid: boolean;
  floorCellCount: number;
  reachableCount: number;
  deadEndCount: number;
  intersectionCount: number;
  hasCycle: boolean;
  // Every distinct simple-path length found from start to exit, up to
  // `routeBudget` expansions or until enough distinct lengths are found to
  // call multiple-routes proven — sorted for stable assertions in tests.
  distinctRouteLengths: number[];
  // Empty when valid; otherwise a human-readable reason per failed check, so
  // a failing level's report says exactly what's wrong rather than just "no".
  errors: string[];
}

const DIRECTIONS: readonly Point[] = [
  { x: 0, y: -1 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
  { x: 1, y: 0 },
];

function key(p: Point): string {
  return `${p.x},${p.y}`;
}

function isWalkableIn(maze: MazeShape, x: number, y: number): boolean {
  return x >= 0 && x < maze.width && y >= 0 && y < maze.height && maze.rows[y][x] === ".";
}

function floorCellsOf(maze: MazeShape): Point[] {
  const cells: Point[] = [];
  for (let y = 0; y < maze.height; y++) {
    for (let x = 0; x < maze.width; x++) {
      if (isWalkableIn(maze, x, y)) cells.push({ x, y });
    }
  }
  return cells;
}

function degreeOf(maze: MazeShape, p: Point): number {
  return DIRECTIONS.filter((d) => isWalkableIn(maze, p.x + d.x, p.y + d.y)).length;
}

// BFS reachability from `start`, over every floor cell — this is what
// "fully connected" means here: not just "exit is reachable" but "every
// walkable cell is," so there's no stray pocket a player could never see a
// future pellet or enemy placed into.
function reachableFrom(maze: MazeShape, start: Point): Set<string> {
  const visited = new Set<string>([key(start)]);
  const queue: Point[] = [start];
  while (queue.length) {
    const p = queue.shift()!;
    for (const d of DIRECTIONS) {
      const n = { x: p.x + d.x, y: p.y + d.y };
      if (isWalkableIn(maze, n.x, n.y) && !visited.has(key(n))) {
        visited.add(key(n));
        queue.push(n);
      }
    }
  }
  return visited;
}

// Bounded DFS enumerating simple-path lengths from start to exit, stopping
// as soon as two distinct lengths are found (proof of "more than one route,
// and they're not just the same path plus a pointless detour") or the
// expansion budget is exhausted. A full enumeration is unnecessary and, on
// the larger levels, combinatorially expensive — the budget keeps this
// validator fast even on level 10's ~130-cell maze.
function distinctRouteLengths(maze: MazeShape, routeBudget: number): number[] {
  const lengths = new Set<number>();
  let expansions = 0;

  function dfs(p: Point, seen: Set<string>, length: number): void {
    if (lengths.size >= 2 || expansions > routeBudget) return;
    expansions++;
    if (p.x === maze.exit.x && p.y === maze.exit.y) {
      lengths.add(length);
      return;
    }
    for (const d of DIRECTIONS) {
      const n = { x: p.x + d.x, y: p.y + d.y };
      const k = key(n);
      if (isWalkableIn(maze, n.x, n.y) && !seen.has(k)) {
        seen.add(k);
        dfs(n, seen, length + 1);
        seen.delete(k);
        if (lengths.size >= 2 || expansions > routeBudget) return;
      }
    }
  }

  dfs(maze.start, new Set([key(maze.start)]), 0);
  return [...lengths].sort((a, b) => a - b);
}

// The single source of truth for "is this a valid level maze," used both by
// spec/levels.test.ts (one call per level) and available for any future
// level-authoring tooling. Checks, in order: START/EXIT are walkable cells;
// every floor cell (not just EXIT) is reachable from START; at least one
// dead end (degree 1) and one intersection (degree >= 3) exist; the floor
// graph contains a genuine cycle (edges >= nodes in a connected graph, the
// same edges-vs-nodes argument used when this project's first maze was
// hand-verified); and at least two distinct simple-route lengths from START
// to EXIT exist, ruling out a maze with exactly one path dressed up with
// decorative dead ends.
export function validateMaze(maze: MazeShape, routeBudget = 200_000): MazeValidationResult {
  const errors: string[] = [];

  if (!isWalkableIn(maze, maze.start.x, maze.start.y)) errors.push("start is not on a walkable cell");
  if (!isWalkableIn(maze, maze.exit.x, maze.exit.y)) errors.push("exit is not on a walkable cell");

  const floor = floorCellsOf(maze);
  const reachable = reachableFrom(maze, maze.start);
  if (reachable.size !== floor.length) {
    errors.push(`only ${reachable.size} of ${floor.length} floor cells are reachable from start`);
  }
  if (!reachable.has(key(maze.exit))) {
    errors.push("exit is not reachable from start");
  }

  const deadEnds = floor.filter((c) => degreeOf(maze, c) === 1);
  const intersections = floor.filter((c) => degreeOf(maze, c) >= 3);
  if (deadEnds.length < 1) errors.push("no dead end (a floor cell with exactly one walkable neighbour)");
  if (intersections.length < 1) errors.push("no intersection (a floor cell with three or more walkable neighbours)");

  let edges = 0;
  for (const c of floor) {
    if (isWalkableIn(maze, c.x + 1, c.y)) edges++;
    if (isWalkableIn(maze, c.x, c.y + 1)) edges++;
  }
  const hasCycle = edges >= floor.length;
  if (!hasCycle) errors.push("no cycle (floor graph is only a spanning tree)");

  const routeLengths = distinctRouteLengths(maze, routeBudget);
  if (routeLengths.length < 2) {
    errors.push(`fewer than two distinct start-to-exit route lengths found (got ${routeLengths.length})`);
  }

  return {
    valid: errors.length === 0,
    floorCellCount: floor.length,
    reachableCount: reachable.size,
    deadEndCount: deadEnds.length,
    intersectionCount: intersections.length,
    hasCycle,
    distinctRouteLengths: routeLengths,
    errors,
  };
}
