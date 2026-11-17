import { describe, expect, it } from "vitest";
import { cellParts, gridDims, packColumns, packRects } from "./gpu-grid";

describe("gridDims", () => {
  it("picks the factor pair nearest 16:9", () => {
    expect(gridDims(40)).toEqual([8, 5]);
    expect(gridDims(20)).toEqual([5, 4]);
    expect(gridDims(4)).toEqual([2, 2]);
  });
});

describe("packColumns (A40, 2026-10-05 19:15)", () => {
  // GPUs held per user, all 40 in use
  const users = [7, 6, 5, 5, 4, 4, 3, 2, 2, 1, 1].map((n, i) => ({ key: `u${i}`, n }));

  it("fills every cell, each user exactly its count", () => {
    const grid = packColumns(users, 8, 5)!;
    const count = new Map<string, number>();
    for (const col of grid) for (const c of col) if (c) count.set(c.key, (count.get(c.key) ?? 0) + 1);
    for (const u of users) expect(count.get(u.key)).toBe(u.n);
  });

  it("keeps a user's cells in at most two adjacent columns, the second from the top", () => {
    const grid = packColumns(users, 8, 5)!;
    const seven = grid.map((col, c) => col.map((x, r) => (x?.key === "u0" ? [c, r] : null)).filter(Boolean)).flat() as number[][];
    const cols = [...new Set(seven.map(([c]) => c))];
    expect(cols).toEqual([0, 1]);
    expect(seven.filter(([c]) => c === 1).map(([, r]) => r)).toEqual([0, 1]);
  });

  it("puts free and offline cells in what is left", () => {
    const grid = packColumns([{ key: "a", n: 3 }, { key: "free", n: 1, filler: true }], 2, 2)!;
    expect(grid.flat().map((c) => c?.key)).toEqual(["a", "a", "a", "free"]);
  });
});

describe("packRects", () => {
  it("A40: every user a rectangle or a rectangle with a short tail, counts exact", async () => {
    const { packRects } = await import("./gpu-grid");
    const users = [7, 6, 5, 5, 4, 4, 3, 2, 2, 1, 1].map((n, i) => ({ key: `u${i}`, n }));
    const out = packRects(users, 8, 5)!;
    const count = new Map<string, number>();
    for (const col of out.grid) for (const c of col) if (c) count.set(c.key, (count.get(c.key) ?? 0) + 1);
    for (const u of users) expect(count.get(u.key)).toBe(u.n);
    // the 6 is a 3 x 2 (or 2 x 3) rectangle
    const b = out.blocks.get("u1")!;
    expect(b.w * b.h).toBe(6);
  });

  it("leaves the fillers' cells for free / offline", async () => {
    const { packRects } = await import("./gpu-grid");
    const out = packRects([{ key: "a", n: 3 }, { key: "free", n: 1, filler: true }], 2, 2)!;
    expect(out.grid.flat().filter((c) => c?.key === "free")).toHaveLength(1);
    expect(out.grid.flat().filter((c) => c?.key === "a")).toHaveLength(3);
  });
});

describe("cellParts (A40, 2026-11-17 17:12)", () => {
  // each part's cells form one connected piece in the grid
  const connected = (cells: [number, number][], ids: number[]) => {
    for (const id of new Set(ids)) {
      const mine = cells.filter((_, i) => ids[i] === id);
      const reach = new Set([0]);
      for (let grew = true; grew;) {
        grew = false;
        mine.forEach((c, i) => {
          if (reach.has(i)) return;
          if ([...reach].some((j) => Math.abs(mine[j][0] - c[0]) + Math.abs(mine[j][1] - c[1]) === 1)) {
            reach.add(i);
            grew = true;
          }
        });
      }
      if (reach.size !== mine.length) return false;
    }
    return true;
  };

  it("keeps a node's pair together beside two single GPUs (s2610205: 4 GPU on 3 nodes)", () => {
    const cells: [number, number][] = [[0, 0], [1, 0], [0, 1], [1, 1]];
    const { part: ids, rank } = cellParts(cells, [1, 1, 2]);
    expect(new Set(ids).size).toBe(3);
    expect(connected(cells, ids)).toBe(true);
    // the pair lies in one row
    const pair = cells.filter((_, i) => ids.filter((x) => x === ids[i]).length === 2);
    expect(pair[0][1]).toBe(pair[1][1]);
    // ids name the parts given: the pair is part 2, its cells ranked 0 and 1
    expect(ids.filter((x) => x === 2).length).toBe(2);
    expect(cells.map((_, i) => i).filter((i) => ids[i] === 2).map((i) => rank[i]).sort()).toEqual([0, 1]);
  });

  it("lays three whole nodes in a 3 × 2 block as three straight pairs", () => {
    const cells: [number, number][] = [];
    for (let r = 0; r < 2; r++) for (let c = 0; c < 3; c++) cells.push([c, r]);
    const ids = cellParts(cells, [2, 2, 2]).part;
    expect(new Set(ids).size).toBe(3);
    expect(connected(cells, ids)).toBe(true);
  });

  it("walks a rectangle with a tail row", () => {
    // three across, then two under the left: 7 = 2 + 2 + 2 + 1
    const cells: [number, number][] = [[0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [2, 1], [0, 2]];
    const ids = cellParts(cells, [2, 2, 2, 1]).part;
    expect(new Set(ids).size).toBe(4);
    expect(connected(cells, ids)).toBe(true);
  });

  it("gives cells past the parts' total one part each", () => {
    const ids = cellParts([[0, 0], [1, 0], [2, 0]], [2]).part;
    expect(new Set(ids).size).toBe(2);
  });
});

describe("packRects with one node's idle GPUs", () => {
  it("keeps a node's idle pair in one piece (Codex review, 2026-11-17)", () => {
    // two two-GPU nodes, one GPU held: before, the pair was filled in
    // reading order and split diagonally ([u, A] / [A, B])
    const out = packRects([
      { key: "u", n: 1 },
      { key: "A", n: 2, filler: true, whole: true },
      { key: "B", n: 1, filler: true, whole: true },
    ], 2, 2)!;
    const at = (k: string) => [0, 1].flatMap((c) => [0, 1].filter((r) => out.grid[c][r]?.key === k).map((r) => [c, r]));
    const [a, b] = at("A");
    expect(Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1])).toBe(1);
  });

  it("keeps every idle node in one piece when many are alike (Codex review, 2026-11-17)", () => {
    // 8 × 5: users of 8 and 5, then three free pairs, a free single and ten
    // reserved pairs; the search used to run out on the pairs' permutations
    // and fall back to columns, which split two of the pairs
    const sizes = [2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2];
    const items = [
      { key: "u8", n: 8 },
      { key: "u5", n: 5 },
      ...sizes.map((n, i) => ({ key: `f${i}`, n, filler: true, whole: true })),
    ];
    const out = packRects(items, 8, 5)!;
    for (const f of items.slice(2)) {
      const cells: number[][] = [];
      for (let c = 0; c < 8; c++) for (let r = 0; r < 5; r++) if (out.grid[c][r]?.key === f.key) cells.push([c, r]);
      expect(cells.length, f.key).toBe(f.n);
      if (f.n === 2) expect(Math.abs(cells[0][0] - cells[1][0]) + Math.abs(cells[0][1] - cells[1][1]), f.key).toBe(1);
    }
  });
});
