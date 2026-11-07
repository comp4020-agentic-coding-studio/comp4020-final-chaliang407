import { describe, expect, it } from "vitest";
import {
  EXIT,
  MAZE_HEIGHT,
  MAZE_WIDTH,
  START,
  floorCells,
  getMazeLayout,
  isExit,
  isWalkable,
  step,
  type Point,
} from "../src/game/maze.ts";

// Pure unit tests of the maze's static geometry, same in-process style as
// spec/logging.test.ts (no running app needed) — this is the "is the maze
// actually a maze" check: connected, with real branching, a cycle, and more
// than one route, not just a corridor with a different paint job.

function key(p: Point): string {
  return `${p.x},${p.y}`;
}

const DIRECTIONS = ["UP", "DOWN", "LEFT", "RIGHT"] as const;

describe("maze geometry", () => {
  it("places START and EXIT on distinct walkable cells", () => {
    expect(isWalkable(START.x, START.y)).toBe(true);
    expect(isWalkable(EXIT.x, EXIT.y)).toBe(true);
    expect(START).not.toEqual(EXIT);
  });

  it("is fully connected: every floor cell is reachable from START", () => {
    const cells = floorCells();
    expect(cells.length).toBeGreaterThan(0);

    const visited = new Set<string>([key(START)]);
    const queue: Point[] = [START];
    while (queue.length) {
      const p = queue.shift()!;
      for (const dir of DIRECTIONS) {
        const n = step(p, dir);
        if (isWalkable(n.x, n.y) && !visited.has(key(n))) {
          visited.add(key(n));
          queue.push(n);
        }
      }
    }

    expect(visited.size).toBe(cells.length);
    expect(visited.has(key(EXIT))).toBe(true);
  });

  it("has at least one intersection (a cell with 3+ walkable neighbours) and one dead end (exactly 1)", () => {
    const cells = floorCells();
    const degree = (p: Point) => DIRECTIONS.filter((d) => isWalkable(step(p, d).x, step(p, d).y)).length;

    const intersections = cells.filter((c) => degree(c) >= 3);
    const deadEnds = cells.filter((c) => degree(c) === 1);

    expect(intersections.length).toBeGreaterThanOrEqual(1);
    expect(deadEnds.length).toBeGreaterThanOrEqual(1);
  });

  it("contains a real cycle, not just a spanning tree (edges >= nodes in the connected component)", () => {
    const cells = floorCells();
    let edges = 0;
    for (const c of cells) {
      // Count each undirected edge once, via its "forward" neighbours only.
      if (isWalkable(c.x + 1, c.y)) edges++;
      if (isWalkable(c.x, c.y + 1)) edges++;
    }
    expect(edges).toBeGreaterThanOrEqual(cells.length);
  });

  it("offers more than one distinct simple route from START to EXIT", () => {
    const routes: number[] = [];
    function dfs(p: Point, visited: Set<string>, len: number): void {
      if (routes.length >= 10) return; // small maze; cap defensively
      if (isExit(p)) {
        routes.push(len);
        return;
      }
      for (const dir of DIRECTIONS) {
        const n = step(p, dir);
        const k = key(n);
        if (isWalkable(n.x, n.y) && !visited.has(k)) {
          visited.add(k);
          dfs(n, visited, len + 1);
          visited.delete(k);
        }
      }
    }
    dfs(START, new Set([key(START)]), 0);

    expect(routes.length).toBeGreaterThanOrEqual(2);
    // Routes of different lengths rule out "two routes that are really the
    // same path with one redundant backtrack."
    expect(new Set(routes).size).toBeGreaterThanOrEqual(2);
  });

  it("treats walls and out-of-bounds as equally unwalkable", () => {
    expect(isWalkable(0, 0)).toBe(false); // the outer wall ring
    expect(isWalkable(-1, 1)).toBe(false); // out of bounds
    expect(isWalkable(MAZE_WIDTH, 1)).toBe(false); // out of bounds
    expect(isWalkable(1, MAZE_HEIGHT)).toBe(false); // out of bounds
  });

  it("serves a layout consistent with the module's own constants", () => {
    const layout = getMazeLayout();
    expect(layout.width).toBe(MAZE_WIDTH);
    expect(layout.height).toBe(MAZE_HEIGHT);
    expect(layout.rows).toHaveLength(MAZE_HEIGHT);
    expect(layout.start).toEqual(START);
    expect(layout.exit).toEqual(EXIT);
  });
});
