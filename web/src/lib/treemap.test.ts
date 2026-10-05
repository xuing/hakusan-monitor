import { describe, expect, it } from "vitest";
import { squarify } from "./treemap";

// A40, 2026-10-05 18:50: GPUs held by user, all 40 in use
const A40 = [7, 6, 5, 5, 4, 4, 3, 2, 2, 1, 1];

describe("squarify", () => {
  it("gives every item its share of the area and fills the box", () => {
    const rects = squarify(A40, (v) => v, 400, 225);
    expect(rects).toHaveLength(A40.length);
    const total = A40.reduce((a, b) => a + b, 0);
    for (const r of rects) expect(r.w * r.h).toBeCloseTo((r.item / total) * 400 * 225, 6);
    const area = rects.reduce((s, r) => s + r.w * r.h, 0);
    expect(area).toBeCloseTo(400 * 225, 6);
    for (const r of rects) {
      expect(r.x).toBeGreaterThanOrEqual(-1e-9);
      expect(r.y).toBeGreaterThanOrEqual(-1e-9);
      expect(r.x + r.w).toBeLessThanOrEqual(400 + 1e-6);
      expect(r.y + r.h).toBeLessThanOrEqual(225 + 1e-6);
    }
  });

  it("skips empty items and an empty box", () => {
    expect(squarify([3, 0, 1], (v) => v, 100, 100)).toHaveLength(2);
    expect(squarify([], (v: number) => v, 100, 100)).toEqual([]);
    expect(squarify([1], (v) => v, 0, 100)).toEqual([]);
  });
});
