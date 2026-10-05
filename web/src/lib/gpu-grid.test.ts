import { describe, expect, it } from "vitest";
import { gridDims, packColumns } from "./gpu-grid";

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
