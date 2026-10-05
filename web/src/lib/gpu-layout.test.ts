/**
 * QoS caps from sacctmgr and node shapes from scontrol (2026-10-05). The
 * emitted flags are the ones measured with held sbatch probes:
 *   GPU-S  `-n 2 -c 26 --gres=gpu:2` → cpu=52, 2 GPUs
 *   GPU-1A `-n 2 -c 13 --gres=gpu:2` → cpu=26, 2 GPUs
 *   GPU-LA `-N 2 --ntasks-per-node=2 -c 26 --gres=gpu:2` → cpu=104, 4 GPUs
 */
import { describe, expect, it } from "vitest";
import { gpuLayouts, maxJobGpus, type GpuNodeShape } from "./gpu-layout";

const A40: GpuNodeShape = { gpus: 2, cores: 52, memMb: 515306, count: 20 };
const A100: GpuNodeShape = { gpus: 2, cores: 52, memMb: 515306, count: 10 };
const H100: GpuNodeShape = { gpus: 1, cores: 32, memMb: 469070, count: 4 };

const GPU_1 = { maxCores: 26, maxMemGb: 256, maxGpus: 1, maxNodes: 1 };
const GPU_S = { maxCores: 52, maxMemGb: 512, maxGpus: 2, maxNodes: 1 };
const GPU_L = { maxCores: 208, maxMemGb: 2048, maxGpus: 8 };
const GPU_1A = { maxCores: 26, maxMemGb: 256, maxNodes: 1 };
const GPU_LA = { maxCores: 208, maxMemGb: 2048 };
const VM_GPU_L = { maxCores: 32, maxMemGb: 458, maxGpus: 1 };

const keys = (r: ReturnType<typeof gpuLayouts>) => r.layouts.map((l) => `${l.gpus}:${l.flags.join(" ") || "-"}`);

describe("single node", () => {
  it("GPU-S: one task per GPU with the node's 26-core share", () => {
    expect(keys(gpuLayouts(GPU_S, A40, false))).toEqual(["1:-", "2:-n 2 -c 26 --gres=gpu:2"]);
  });

  it("GPU-1A: the share shrinks to fit the 26-core QoS", () => {
    expect(keys(gpuLayouts(GPU_1A, A100, false))).toEqual(["1:-", "2:-n 2 -c 13 --gres=gpu:2"]);
  });

  it("GPU-1 stays at 1: its QoS caps GPUs at 1", () => {
    const r = gpuLayouts(GPU_1, A40, false);
    expect(keys(r)).toEqual(["1:-"]);
    expect(r.fullNodeBlocked).toBe("gpus");
  });

  it("VM-GPU-L (one H100 per node) has nothing beyond 1 GPU", () => {
    expect(keys(gpuLayouts(VM_GPU_L, H100, false))).toEqual(["1:-"]);
  });
});

describe("multi node", () => {
  it("GPU-L packs whole nodes up to the 8-GPU QoS", () => {
    const r = gpuLayouts(GPU_L, A40, true);
    const packed = r.layouts.filter((l) => l.packed && l.gpus > 1);
    expect(packed.map((l) => l.flags.join(" "))).toEqual([
      "-n 2 -c 26 --gres=gpu:2",
      "-N 2 --ntasks-per-node=2 -c 26 --gres=gpu:2",
      "-N 3 --ntasks-per-node=2 -c 26 --gres=gpu:2",
      "-N 4 --ntasks-per-node=2 -c 26 --gres=gpu:2",
    ]);
    for (const l of r.layouts) expect(l.gpus * Math.max(1, l.coresPerGpu)).toBeLessThanOrEqual(208);
  });

  it("spread: one GPU and 26 cores per node, up to 8 nodes", () => {
    const r = gpuLayouts(GPU_L, A40, true);
    expect(r.layouts.filter((l) => !l.packed && l.gpus > 1).map((l) => l.nodes)).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect(r.layouts.find((l) => l.key === "s3")?.flags).toEqual(["-N 3", "--ntasks-per-node=1", "-c 26", "--gres=gpu:1"]);
  });

  it("orders by GPU count, packed before spread at the same count", () => {
    const twos = gpuLayouts(GPU_L, A40, true).layouts.filter((l) => l.gpus === 2).map((l) => l.key);
    expect(twos).toEqual(["p1", "s2"]);
  });

  it("GPU-LA has no GPU cap — cores (208) are what stop it", () => {
    expect(Math.max(...gpuLayouts(GPU_LA, A100, true).layouts.map((l) => l.gpus))).toBe(8);
  });
});

describe("policy-limit GPU number = most GPUs one job can really get", () => {
  it("matches the largest choice under 高级参数 for every GPU partition", () => {
    const cases: Array<[object, GpuNodeShape, boolean, number]> = [
      [GPU_1, A40, false, 1],
      [GPU_S, A40, false, 2],
      [GPU_L, A40, true, 8],
      [GPU_1A, A100, false, 2],
      [GPU_LA, A100, true, 8],
      [VM_GPU_L, H100, false, 1],
    ];
    for (const [cap, shape, multi, want] of cases) expect(maxJobGpus(cap, shape, multi)).toBe(want);
  });
});
