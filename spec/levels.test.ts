import { describe, expect, it } from "vitest";
import { EXIT as MAZE_EXIT, START as MAZE_START, getMazeLayout } from "../src/game/maze.ts";
import { LEVELS, LEVEL_COUNT, getLevel } from "../src/game/levels.ts";
import { validateMaze } from "../src/game/mazeValidator.ts";

// Pure unit tests of the ten level layouts' static geometry — same in-process
// style as spec/maze.test.ts (no running app, no DB), but parametrized across
// every level via the shared src/game/mazeValidator.ts rather than repeating
// spec/maze.test.ts's checks by hand ten times. Scope: level geometry and
// pellet/enemy *spawn position* data only — no pellet collection, scoring,
// enemy movement, collision, or runtime DB wiring exists yet (that's a later
// milestone); this file only proves the fixed data itself is well-formed.

describe("level roster", () => {
  it("defines exactly ten levels, numbered 1 through 10 with no gaps", () => {
    expect(LEVEL_COUNT).toBe(10);
    expect(LEVELS.map((l) => l.level)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("getLevel returns the matching definition and rejects out-of-range levels", () => {
    expect(getLevel(1).level).toBe(1);
    expect(getLevel(10).level).toBe(10);
    expect(() => getLevel(0)).toThrow();
    expect(() => getLevel(11)).toThrow();
  });

  it("assigns the approved enemy-count schedule (0,0,1,1,2,2,3,3,4,4) without wiring any enemy behaviour yet", () => {
    expect(LEVELS.map((l) => l.enemyCount)).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 4]);
    // The schedule and the actual spawn list length must agree level by
    // level — enemyCount is otherwise just an unchecked number sitting next
    // to the data it's supposed to describe.
    expect(LEVELS.map((l) => l.enemySpawns.length)).toEqual(LEVELS.map((l) => l.enemyCount));
  });
});

describe("level 1 is byte-identical to the existing maze", () => {
  const level1 = getLevel(1);
  const existing = getMazeLayout();

  it("has the same dimensions, grid, start, and exit as src/game/maze.ts", () => {
    expect(level1.maze.width).toBe(existing.width);
    expect(level1.maze.height).toBe(existing.height);
    expect(level1.maze.rows).toEqual(existing.rows);
    expect(level1.maze.start).toEqual(existing.start);
    expect(level1.maze.exit).toEqual(existing.exit);
    expect(level1.maze.start).toEqual(MAZE_START);
    expect(level1.maze.exit).toEqual(MAZE_EXIT);
  });
});

describe.each(LEVELS.map((def) => [def.level, def] as const))("level %i", (levelNumber, def) => {
  const result = validateMaze(def.maze);

  it("is a fully valid maze: connected, with a dead end, an intersection, a cycle, and multiple routes", () => {
    expect(result.errors, `level ${levelNumber} failed validation: ${result.errors.join("; ")}`).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("places START and EXIT on distinct walkable cells", () => {
    expect(def.maze.start).not.toEqual(def.maze.exit);
  });

  it("has every floor cell reachable from START, including EXIT", () => {
    expect(result.reachableCount).toBe(result.floorCellCount);
  });

  it("has at least one dead end and one intersection", () => {
    expect(result.deadEndCount).toBeGreaterThanOrEqual(1);
    expect(result.intersectionCount).toBeGreaterThanOrEqual(1);
  });

  it("contains a genuine cycle, not just a spanning tree", () => {
    expect(result.hasCycle).toBe(true);
  });

  it("offers at least two distinct-length routes from START to EXIT", () => {
    expect(result.distinctRouteLengths.length).toBeGreaterThanOrEqual(2);
  });

  it("has exactly enemyCount enemy spawns", () => {
    expect(def.enemySpawns).toHaveLength(def.enemyCount);
  });

  it("places every pellet spawn on a walkable tile, not on START or EXIT", () => {
    for (const p of def.pelletSpawns) {
      expect(
        def.maze.rows[p.y]?.[p.x],
        `level ${levelNumber} pellet (${p.x},${p.y}) is not a walkable tile`,
      ).toBe(".");
      expect(p, `level ${levelNumber} pellet (${p.x},${p.y}) overlaps START`).not.toEqual(def.maze.start);
      expect(p, `level ${levelNumber} pellet (${p.x},${p.y}) overlaps EXIT`).not.toEqual(def.maze.exit);
    }
  });

  it("places every enemy spawn on a walkable tile, not on START or EXIT", () => {
    for (const e of def.enemySpawns) {
      expect(
        def.maze.rows[e.y]?.[e.x],
        `level ${levelNumber} enemy (${e.x},${e.y}) is not a walkable tile`,
      ).toBe(".");
      expect(e, `level ${levelNumber} enemy (${e.x},${e.y}) overlaps START`).not.toEqual(def.maze.start);
      expect(e, `level ${levelNumber} enemy (${e.x},${e.y}) overlaps EXIT`).not.toEqual(def.maze.exit);
    }
  });

  it("has no duplicate spawn positions, among pellets, among enemies, or between the two", () => {
    const seen = new Set<string>();
    const key = (p: { x: number; y: number }) => `${p.x},${p.y}`;
    for (const p of def.pelletSpawns) {
      expect(seen.has(key(p)), `level ${levelNumber} has a duplicate pellet at (${p.x},${p.y})`).toBe(false);
      seen.add(key(p));
    }
    for (const e of def.enemySpawns) {
      expect(
        seen.has(key(e)),
        `level ${levelNumber} has an enemy spawn colliding with another spawn at (${e.x},${e.y})`,
      ).toBe(false);
      seen.add(key(e));
    }
  });

  it("has at least one pellet to collect", () => {
    expect(def.pelletSpawns.length).toBeGreaterThan(0);
  });
});

describe("complexity increases gradually across levels", () => {
  it("has non-decreasing floor-cell count from level to level", () => {
    const counts = LEVELS.map((def) => validateMaze(def.maze).floorCellCount);
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i], `level ${i + 1} (${counts[i]} floor cells) is smaller than level ${i} (${counts[i - 1]})`).toBeGreaterThanOrEqual(
        counts[i - 1],
      );
    }
  });

  it("has non-decreasing intersection count from level to level", () => {
    const counts = LEVELS.map((def) => validateMaze(def.maze).intersectionCount);
    for (let i = 1; i < counts.length; i++) {
      expect(
        counts[i],
        `level ${i + 1} (${counts[i]} intersections) has fewer than level ${i} (${counts[i - 1]})`,
      ).toBeGreaterThanOrEqual(counts[i - 1]);
    }
  });

  it("strictly grows in floor-cell count from level 1 to level 10 overall", () => {
    const first = validateMaze(LEVELS[0].maze).floorCellCount;
    const last = validateMaze(LEVELS[LEVELS.length - 1].maze).floorCellCount;
    expect(last).toBeGreaterThan(first);
  });
});

describe("maze validator itself", () => {
  it("flags a disconnected maze as invalid, naming the reachability failure", () => {
    const broken = {
      width: 5,
      height: 3,
      rows: ["#####", "#.#.#", "#####"],
      start: { x: 1, y: 1 },
      exit: { x: 3, y: 1 },
    };
    const result = validateMaze(broken);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("reachable"))).toBe(true);
  });

  it("flags a maze with no cycle (a pure corridor) as invalid", () => {
    const corridor = {
      width: 5,
      height: 3,
      rows: ["#####", "#...#", "#####"],
      start: { x: 1, y: 1 },
      exit: { x: 3, y: 1 },
    };
    const result = validateMaze(corridor);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("cycle"))).toBe(true);
    expect(result.errors.some((e) => e.includes("route"))).toBe(true);
  });

  it("flags a start or exit placed on a wall", () => {
    const wallStart = {
      width: 5,
      height: 3,
      rows: ["#####", "#...#", "#####"],
      start: { x: 0, y: 0 },
      exit: { x: 3, y: 1 },
    };
    const result = validateMaze(wallStart);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("start"))).toBe(true);
  });
});
