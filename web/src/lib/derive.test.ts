import { describe, expect, it } from "vitest";
import { gpuNodeParts, idleGpuBucket, poolNodeStates, unschedulableCores } from "@/lib/derive";
import type { RawNode, Snapshot } from "@/types/snapshot";

const node = (name: string, state: string[], alloc: number, schedulable: boolean): RawNode =>
  ({ name, pool: "cpu", state, cpus: 256, alloc_cpus: alloc, schedulable }) as unknown as RawNode;

describe("unschedulableCores", () => {
  it("splits idle cores the free count leaves out into held and down", () => {
    const held = unschedulableCores([
      node("a", ["MIXED"], 200, true),                // schedulable: its 56 are free, not here
      node("b", ["MIXED", "PLANNED"], 243, false),    // held for a queued job
      node("c", ["IDLE", "DRAIN"], 0, false),         // taken out by an operator
      node("d", ["ALLOCATED"], 256, false),           // full: nothing idle
    ], "cpu");
    expect(held).toEqual({ reserved: 13, down: 256 });
  });
});

describe("poolNodeStates", () => {
  it("sorts every node by what it offers now", () => {
    const snap = { nodes: [
      node("idle", ["IDLE"], 0, true),
      node("part", ["MIXED"], 64, true),            // the large-memory node: 64 of 256 cores used here
      node("held", ["MIXED", "PLANNED"], 243, false),
      node("full", ["ALLOCATED"], 256, false),
      node("down", ["IDLE", "DRAIN"], 0, false),
    ] } as unknown as Snapshot;
    expect(poolNodeStates(snap, "cpu")).toEqual({ idle: 1, partial: 1, held: 1, full: 1, down: 1 });
  });
});

describe("idleGpuBucket (backend/normalize.py idle_gpu_bucket)", () => {
  it("puts a node's idle GPUs where the pool counts them", () => {
    expect(idleGpuBucket(node("a", ["MIXED"], 26, true))).toBe("free");
    expect(idleGpuBucket(node("b", ["IDLE", "DRAIN"], 0, false))).toBe("down");
    expect(idleGpuBucket(node("c", ["IDLE", "PLANNED"], 0, false))).toBe("reserved");
    // every core allocated: the GPU waits for a core
    expect(idleGpuBucket(node("d", ["ALLOCATED"], 52, false))).toBe("short");
  });
});

describe("gpuNodeParts (A40, 2026-11-17 17:12)", () => {
  const job = (id: number, user: string, gpus: number, nodelist: string, partition = "GPU-1") =>
    ({ job_id: id, user_name: user, job_state: "RUNNING", partition, gpus, nodelist });
  const a40 = (name: string) => ({ name, pool: "a40", gres: "gpu:nvidia_a40:2(S:0-1)" });
  const snap = {
    part_pool: { "GPU-1": "a40", "GPU-S": "a40", "GPU-L": "a100" },
    pools: [{ id: "a40", gpu: { type: "nvidia_a40" } }],
    nodes: ["01", "02", "03", "04", "05", "08", "12", "13", "14"].map((n) => a40(`spcc-a40g${n}`)),
    jobs: [
      // s2510464: two one-GPU jobs on a40g13 make one node's pair
      job(991685, "s2510464", 1, "spcc-a40g13"),
      job(991686, "s2510464", 1, "spcc-a40g13"),
      job(991684, "s2510464", 1, "spcc-a40g12"),
      // s2610205: one two-GPU job on a40g05, two singles
      job(1000167, "s2610205", 2, "spcc-a40g05", "GPU-S"),
      job(971915, "s2610205", 1, "spcc-a40g14"),
      job(971914, "s2610205", 1, "spcc-a40g08"),
      // four GPUs over two two-GPU nodes: both full, so two on each
      job(1, "multi", 4, "spcc-a40g[01-02]"),
      // three over two nodes: the split is not in the snapshot, so each alone
      job(4, "uneven", 3, "spcc-a40g[03-04]"),
      // another pool, and a pending job: left out
      job(2, "s2510464", 1, "spcc-a100g01", "GPU-L"),
      { ...job(3, "s2610205", 1, ""), job_state: "PENDING" },
    ],
  } as unknown as Snapshot;

  it("counts each user's GPUs per node", () => {
    const parts = gpuNodeParts(snap, "a40");
    expect(parts.get("s2510464")!.sort()).toEqual([1, 2]);
    expect(parts.get("s2610205")!.sort()).toEqual([1, 1, 2]);
    expect(parts.get("multi")).toEqual([2, 2]);
    expect(parts.get("uneven")).toEqual([1, 1, 1]);
  });
});
