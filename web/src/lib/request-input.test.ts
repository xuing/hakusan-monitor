import { describe, expect, it } from "vitest";
import {
  largestPassing,
  logTicks,
  niceCoreCount,
  normalizeMem,
  numberOptions,
  parseHumanTime,
  parseMemoryInputMb,
  quantizeWalltime,
  walltimeTicks,
  withinCapInt,
} from "./request-input";

describe("request fields", () => {
  it("reads walltimes as people and Slurm write them", () => {
    expect(parseHumanTime("3d")).toBe(3 * 86400);
    expect(parseHumanTime("1d12h")).toBe(36 * 3600);
    expect(parseHumanTime("90m")).toBe(5400);
    expect(parseHumanTime("2-00:00:00")).toBe(2 * 86400);
    expect(parseHumanTime("12:00:00")).toBe(12 * 3600);
    expect(parseHumanTime("soon")).toBe(0);
  });

  it("takes --mem as a whole number with a unit, in MiB", () => {
    expect(normalizeMem(" 32g ")).toBe("32G");
    expect(normalizeMem("32")).toBe("");
    expect(parseMemoryInputMb("2T")).toBe(2 * 1024 * 1024);
    expect(parseMemoryInputMb("512M")).toBe(512);
  });

  it("drops a value outside the partition's bounds rather than clamping it", () => {
    expect(withinCapInt("300", 256)).toBe(0);
    expect(withinCapInt("128", 2048, 256)).toBe(0);   // under LARGE's MinTRES: refused at submit
    expect(withinCapInt("512", 2048, 256)).toBe(512);
  });

  it("offers node counts up to the limit, the limit itself included", () => {
    expect(numberOptions(6, [1, 2, 4, 8])).toEqual([1, 2, 4, 6]);
  });

  it("finds the largest value a monotone test passes", () => {
    expect(largestPassing(1, 100, (v) => v <= 37)).toBe(37);
    expect(largestPassing(5, 100, () => false)).toBe(4);
  });
});

describe("slider axes", () => {
  it("rounds a dragged walltime to a step a person would type", () => {
    expect(quantizeWalltime(3500)).toBe(3600);
    expect(quantizeWalltime(5 * 3600 + 700)).toBe(5 * 3600);
  });

  it("snaps a clicked core count to a power of two when close, else a round step", () => {
    expect(niceCoreCount(250)).toBe(256);
    expect(niceCoreCount(700)).toBe(704);
  });

  it("keeps log ticks and walltime ticks from touching", () => {
    expect(logTicks(8192).map((t) => t.label)).toEqual(["1", "4", "16", "64", "256", "1K", "8K"]);   // 4K would touch 8K
    expect(walltimeTicks(600, 7 * 86400).map((t) => t.label)).toEqual(["10m", "1h", "6h", "1d", "7d"]);
  });
});
