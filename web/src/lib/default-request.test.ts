/**
 * Measured 2026-07-29 on hakusan2. Every expectation below was confirmed by a
 * real submission; the commands are quoted next to each case.
 */
import { describe, expect, it } from "vitest";
import { defaultRequestFit, singleNodeCoreFlag } from "./default-request";
import { REQUEST_GPU_1, REQUEST_VM_GPU_L } from "./gpu-availability.fixtures";

const req = (partition: string, cores: number, memPerCoreMb: number) =>
  ({ partition, cores, memPerCoreMb, gpusPerNode: 1 });

describe("default request vs one node", () => {
  it("passes GPU-1: 26 x 9845 = 255970 MB on a 515306 MB A40 node", () => {
    // sbatch --test-only -p GPU-1 -> "using 26 processors on nodes spcc-a40g15"
    const fit = defaultRequestFit(REQUEST_GPU_1, { cores: 52, memMb: 515306 })!;

    expect(fit.fitsOneNode).toBe(true);
    expect(fit.memMb).toBe(255970);
    expect(fit.nodesNeeded).toBe(1);
    expect(singleNodeCoreFlag(fit)).toBe("");
  });

  it("flags VM-GPU-L: 32 x 14900 = 476800 MB on a 469070 MB node", () => {
    // salloc -p VM-GPU-L -> NodeList=spcc-cld-gl[02-03],
    //   AllocTRES=cpu=32,mem=476800M,node=2,gres/gpu:h100-80c=2
    // sbatch --test-only -p VM-GPU-L -N1 -n 32
    //   -> "allocation failure: Requested node configuration is not available"
    const fit = defaultRequestFit(REQUEST_VM_GPU_L, { cores: 32, memMb: 469070 })!;

    expect(fit.fitsOneNode).toBe(false);
    expect(fit.shortfallMb).toBe(7730);
    expect(fit.maxCoresOnOneNode).toBe(31);
    expect(fit.nodesNeeded).toBe(2);
    // sbatch -p VM-GPU-L -n 31 -> NodeList=spcc-cld-gl02, NumNodes=1,
    //   AllocTRES=cpu=31,mem=461900M,node=1,gres/gpu:h100-80c=1
    expect(singleNodeCoreFlag(fit)).toBe("-n 31");
  });

  it("flags VM-CPU: identical hardware, identical overshoot", () => {
    // sbatch -p VM-CPU -> NodeList=spcc-cld-[05-06], NumNodes=2
    const fit = defaultRequestFit(req("VM-CPU", 32, 14900), { cores: 32, memMb: 469070 })!;

    expect(fit.fitsOneNode).toBe(false);
    expect(singleNodeCoreFlag(fit)).toBe("-n 31");
  });

  it("flags VM-LM: 96 x 39300 = 3772800 MB on the pool's only 3754178 MB node", () => {
    // sbatch -p VM-LM --wrap 'sleep 5'
    //   -> "Batch job submission failed: Requested topology configuration is
    //       not available"  (node was IDLE with nothing allocated)
    // sbatch --test-only -p VM-LM -n 95 -> "using 95 processors on nodes spcc-cld-lm01"
    const fit = defaultRequestFit(req("VM-LM", 96, 39300), { cores: 96, memMb: 3754178 })!;

    expect(fit.fitsOneNode).toBe(false);
    expect(fit.shortfallMb).toBe(18622);
    expect(fit.maxCoresOnOneNode).toBe(95);
    expect(singleNodeCoreFlag(fit)).toBe("-n 95");
  });

  it("passes DEF: 16 x 6000 on a 1543224 MB lcpcc node", () => {
    expect(defaultRequestFit(req("DEF", 16, 6000), { cores: 256, memMb: 1543224 })!.fitsOneNode).toBe(true);
  });

  it("passes the largest lcpcc default: 256 x 6000 = 1536000 MB, 7224 MB to spare", () => {
    const fit = defaultRequestFit(req("LARGE", 256, 6000), { cores: 256, memMb: 1543224 })!;

    expect(fit.fitsOneNode).toBe(true);
    expect(fit.node.memMb - fit.memMb).toBe(7224);
  });

  it("returns null rather than a guess when the measured defaults are missing", () => {
    expect(defaultRequestFit(req("X", 0, 0), { cores: 32, memMb: 469070 })).toBeNull();
    expect(singleNodeCoreFlag(null)).toBe("");
  });
});
