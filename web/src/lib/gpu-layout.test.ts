/**
 * Every case uses the live 2026-10-01 policy: QoS caps from sacctmgr, plugin
 * facts from job_submit.lua (gpu_request_respected=false on all GPU
 * partitions), node shapes from scontrol. Commands for the "plugin fixed"
 * cases are what the same code emits once gpu_request_respected flips.
 */
import { describe, expect, it } from "vitest";
import { gpuLayouts, type GpuNodeShape } from "./gpu-layout";

const A40: GpuNodeShape = { gpus: 2, cores: 52, memMb: 515306, count: 20 };
const A100: GpuNodeShape = { gpus: 2, cores: 52, memMb: 515306, count: 10 };
const H100: GpuNodeShape = { gpus: 1, cores: 32, memMb: 469070, count: 4 };
const FORCED = { gpusPerNode: 1, gpuRequestRespected: false, defaultCores: 26 };
const FIXED = { gpusPerNode: 1, gpuRequestRespected: true, defaultCores: 26 };

const GPU_1 = { maxCores: 26, maxMemGb: 256, maxGpus: 1, maxNodes: 1 };
const GPU_S = { maxCores: 52, maxMemGb: 512, maxGpus: 2, maxNodes: 1 };
const GPU_L = { maxCores: 208, maxMemGb: 2048, maxGpus: 8 };
const GPU_1A = { maxCores: 26, maxMemGb: 256, maxNodes: 1 };
const GPU_LA = { maxCores: 208, maxMemGb: 2048 };
const VM_GPU_L = { maxCores: 32, maxMemGb: 458, maxGpus: 1 };

const keys = (r: ReturnType<typeof gpuLayouts>) => r.layouts.map((l) => `${l.gpus}:${l.flags.join(" ") || "-"}`);

describe("today: plugin pins 1 GPU per node", () => {
  it("GPU-S offers the whole node via --exclusive (measured: both A40s)", () => {
    expect(keys(gpuLayouts(GPU_S, FORCED, A40, false))).toEqual(["1:-", "2:--exclusive"]);
  });

  it("GPU-1 / GPU-1A refuse a second GPU: a whole node exceeds their 26-core cap", () => {
    for (const cap of [GPU_1, GPU_1A]) {
      const r = gpuLayouts(cap, FORCED, cap === GPU_1 ? A40 : A100, false);
      expect(keys(r)).toEqual(["1:-"]);
      expect(r.fullNodeBlocked).toBe("cores");
    }
  });

  it("GPU-L packs whole nodes first and stops at the 208-core QoS (4 nodes = 8 A40)", () => {
    const r = gpuLayouts(GPU_L, FORCED, A40, true);
    const packed = r.layouts.filter((l) => l.packed && l.gpus > 1);
    expect(packed.map((l) => l.flags.join(" "))).toEqual(["--exclusive", "-N 2 --exclusive", "-N 3 --exclusive", "-N 4 --exclusive"]);
    expect(Math.max(...r.layouts.map((l) => l.nodes * (l.exclusive ? 52 : 26)))).toBeLessThanOrEqual(208);
    // spread: one A40 + 26 cores per node, up to 8 nodes (8 x 26 = 208)
    expect(r.layouts.filter((l) => !l.packed && l.gpus > 1).map((l) => l.nodes)).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect(r.layouts.find((l) => l.key === "s3")?.flags).toEqual(["-N 3", "--ntasks-per-node=1", "-c 26"]);
  });

  it("orders by GPU count, packed before spread at the same count", () => {
    const r = gpuLayouts(GPU_L, FORCED, A40, true);
    const twos = r.layouts.filter((l) => l.gpus === 2).map((l) => l.key);
    expect(twos).toEqual(["p1", "s2"]);
  });

  it("GPU-LA has no GPU cap — cores (208) are what stop it", () => {
    const r = gpuLayouts(GPU_LA, FORCED, A100, true);
    expect(Math.max(...r.layouts.map((l) => l.gpus))).toBe(8);
  });

  it("VM-GPU-L (one H100 per node, 32-core cap) has nothing beyond 1 GPU", () => {
    expect(keys(gpuLayouts(VM_GPU_L, FORCED, H100, false))).toEqual(["1:-"]);
  });
});

describe("after the plugin fix: --gres works again", () => {
  it("GPU-S asks --gres=gpu:2 instead of booking the whole node", () => {
    expect(keys(gpuLayouts(GPU_S, FIXED, A40, false))).toEqual(["1:-", "2:--gres=gpu:2"]);
  });

  it("GPU-1A gets 2 A100s within its 26 cores (as 14 jobs did before 2026-06-11)", () => {
    expect(keys(gpuLayouts(GPU_1A, FIXED, A100, false))).toEqual(["1:-", "2:--gres=gpu:2"]);
  });

  it("GPU-1 stays at 1: its QoS caps GPUs at 1", () => {
    const r = gpuLayouts(GPU_1, FIXED, A40, false);
    expect(keys(r)).toEqual(["1:-"]);
    expect(r.fullNodeBlocked).toBe("gpus");
  });

  it("multi-node packs pin one task per GPU", () => {
    const l = gpuLayouts(GPU_L, FIXED, A40, true).layouts.find((x) => x.key === "p2");
    expect(l?.flags).toEqual(["-N 2", "--ntasks-per-node=2", "-c 26", "--gres=gpu:2"]);
  });
});
