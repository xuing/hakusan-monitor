import { describe, expect, it } from "vitest";
import { barCells, scaleCells } from "@/lib/unit-cells";

describe("scaleCells", () => {
  it("keeps a cell for every segment that is not zero", () => {
    // free, stranded, used, reserved, down — the CPU pool on 2026-10-06
    const cells = scaleCells([107, 0, 31_531, 106, 0], 31_744, 96);
    expect(cells).toEqual([1, 0, 94, 1, 0]);
    expect(cells.reduce((a, b) => a + b, 0)).toBe(96);
  });

  it("draws one cell per unit when the pool is small", () => {
    expect(scaleCells([3, 0, 5, 0, 0], 8, 48)).toEqual([3, 0, 5, 0, 0]);
  });

  it("gives bigger pools more cells", () => {
    expect([barCells(31_744), barCells(1_408), barCells(96)]).toEqual([96, 48, 24]);
  });

  it("draws one cell per node", () => {
    expect([barCells(31_744, 124), barCells(1_408, 44), barCells(96, 1)]).toEqual([124, 44, 1]);
    expect(scaleCells([1_376, 0, 32, 0, 0], 1_408, 44)).toEqual([43, 0, 1, 0, 0]);
  });
});
