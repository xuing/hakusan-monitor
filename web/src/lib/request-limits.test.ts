/**
 * Bounds and boundary commands for a small snapshot shaped like the live
 * 2026-10-01 cluster (QoS caps, plugin facts, node shapes). The values pinned
 * here are the ones the boundary sweep proved Slurm can run.
 */
import { describe, expect, it } from "vitest";
import { boundaryCommands, requestLimits } from "./request-limits";
import type { Snapshot } from "@/types/snapshot";

const gpuDefaults = { cores: 26, tasks: 26, gpus_per_node: 1, gpu_request_respected: true, interactive_time_min: 720,
                      def_mem_per_cpu_mb: 9845, max_mem_per_cpu_mb: 9845 };
const cpuDefaults = (tasks: number) => ({ cores: tasks, tasks, interactive_time_min: 2880, def_mem_per_cpu_mb: 6000, max_mem_per_cpu_mb: 6000 });

const snap = {
  pools: [
    { id: "a40", kind: "gpu", nodes: 20, mem_per_node: 515306, cores: { total: 1040 }, gpu: { maint: false }, partitions: ["GPU-1", "GPU-S", "GPU-L"] },
    { id: "cpu", kind: "cpu", nodes: 124, mem_per_node: 1543224, cores: { total: 31744 }, partitions: ["DEF", "SMALL", "MatStudio"] },
  ],
  partitions: [
    { name: "GPU-1", nodes: 20, spec: { gpu_per_node: 2 } },
    { name: "GPU-S", nodes: 20, spec: { gpu_per_node: 2 } },
    { name: "GPU-L", nodes: 20, spec: { gpu_per_node: 2 } },
    { name: "DEF", nodes: 124, spec: { gpu_per_node: 0 } },
    { name: "SMALL", nodes: 124, spec: { gpu_per_node: 0 } },
    { name: "MatStudio", nodes: 124, spec: { gpu_per_node: 0 } },
  ],
  policy: {
    partition_caps: {
      "GPU-1": { maxCores: 26, maxMemGb: 256, maxGpus: 1, maxNodes: 1, wall: "7d" },
      "GPU-S": { maxCores: 52, maxMemGb: 512, maxGpus: 2, maxNodes: 1, wall: "5d" },
      "GPU-L": { maxCores: 208, maxMemGb: 2048, maxGpus: 8, wall: "3d" },
      DEF: { maxCores: 64, maxMemGb: 384, maxNodes: 1, wall: "7d" },
      SMALL: { maxCores: 768, maxMemGb: 4608, wall: "7d" },
      MatStudio: { maxCores: 32, maxMemGb: 192, wall: "7d" },
    },
    partition_defaults: {
      "GPU-1": gpuDefaults, "GPU-S": gpuDefaults, "GPU-L": gpuDefaults,
      DEF: cpuDefaults(16), SMALL: cpuDefaults(256), MatStudio: { ...cpuDefaults(8), requires_license: true },
    },
  },
} as unknown as Snapshot;

const byKey = (rows: ReturnType<typeof boundaryCommands>) =>
  Object.fromEntries(rows.map((r) => [`${r.partition} ${r.field}`, r.args]));

describe("requestLimits", () => {
  it("bounds per-node memory by the node's cores (GPU-L 499G, SMALL 1500G)", () => {
    const a40 = { nodes: 20, coresPerNode: 52, memPerNodeMb: 515306, gpusPerNode: 2 };
    const lcpcc = { nodes: 124, coresPerNode: 256, memPerNodeMb: 1543224, gpusPerNode: 0 };
    expect(requestLimits("GPU-L", snap.policy, a40, true).maxMemGb).toBe(499);
    expect(requestLimits("SMALL", snap.policy, lcpcc, false).maxMemGb).toBe(1500);
  });

  it("offers -N only on multi-node CPU partitions, within the pool and the task count", () => {
    const lcpcc = { nodes: 124, coresPerNode: 256, memPerNodeMb: 1543224, gpusPerNode: 0 };
    expect(requestLimits("SMALL", snap.policy, lcpcc, false).maxNodes).toBe(124);
    expect(requestLimits("SMALL", snap.policy, lcpcc, false, 16).maxNodes).toBe(16); // -n 16 -> at most 16 nodes
    expect(requestLimits("DEF", snap.policy, lcpcc, false).maxNodes).toBe(0);
    expect(requestLimits("GPU-L", snap.policy, { ...lcpcc, coresPerNode: 52 }, true).maxNodes).toBe(0);
  });
});

describe("boundaryCommands", () => {
  const rows = byKey(boundaryCommands(snap));

  it("emits the UI's own spelling of each field's largest value", () => {
    expect(rows["GPU-1 cores"]).toBe("-p GPU-1 -n 1 -c 26");
    expect(rows["GPU-L mem"]).toBe("-p GPU-L --mem=499G");
    expect(rows["SMALL cores"]).toBe("-p SMALL -n 768");
    expect(rows["SMALL nodes"]).toBe("-p SMALL -N 124");
    expect(rows["DEF time"]).toBe("-p DEF -t 7-00:00:00");
  });

  it("includes every multi-GPU layout and skips license-only partitions", () => {
    expect(rows["GPU-S gpu:p1"]).toBe("-p GPU-S -n 2 -c 26 --gres=gpu:2");
    expect(rows["GPU-L gpu:p4"]).toBe("-p GPU-L -N 4 --ntasks-per-node=2 -c 26 --gres=gpu:2");
    expect(rows["GPU-L gpu:s8"]).toBe("-p GPU-L -N 8 --ntasks-per-node=1 -c 26 --gres=gpu:1");
    expect(rows["GPU-1 gpu:p1"]).toBeUndefined();
    expect(Object.keys(rows).some((k) => k.startsWith("MatStudio"))).toBe(false);
  });
});
