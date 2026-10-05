import { describe, expect, it } from "vitest";
import { occupancyMode } from "./occupancy-mode";
import type { Pool, Snapshot } from "@/types/snapshot";

// pool shapes and QoS core caps on hakusan, 2026-10-05
const pool = (id: string, kind: "gpu" | "cpu", nodes: number, cores: number, partitions: string[]) =>
  ({ id, kind, nodes, cores: { total: cores, alloc: 0, free: cores, util: 0 }, partitions, gpu: null }) as unknown as Pool;
const snap = {
  policy: { partition_caps: { "VM-CPU": { maxCores: 32 }, "VM-LM": { maxCores: 96 }, DEF: { maxCores: 64 }, SMALL: { maxCores: 768 } } },
} as unknown as Snapshot;

describe("occupancyMode", () => {
  it("a GPU pool: one cell per GPU", () => {
    expect(occupancyMode(pool("a40", "gpu", 20, 1040, ["GPU-1"]), snap)).toMatchObject({ grid: true, dashed: false });
  });
  it("the 96-core large-memory node: one dashed cell per core", () => {
    expect(occupancyMode(pool("lm", "cpu", 1, 96, ["VM-LM"]), snap)).toMatchObject({ grid: true, dashed: true });
  });
  it("VM-CPU: no job outgrows a 32-core VM, one row per node", () => {
    expect(occupancyMode(pool("vm-cpu", "cpu", 44, 1408, ["VM-CPU"]), snap)).toMatchObject({ grid: false, perRow: 32 });
  });
  it("lcpcc: SMALL spans nodes, a treemap", () => {
    expect(occupancyMode(pool("cpu", "cpu", 124, 31744, ["DEF", "SMALL"]), snap)).toMatchObject({ grid: false, perRow: undefined });
  });
});
