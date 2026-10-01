import { describe, expect, it } from "vitest";
import { allowsMultiNode, effectiveJobMemGb, effectiveMemPerNodeGb } from "./slurm";

// Measured 2026-07-11 on Hakusan: GPU-S QOS MaxTRES mem=512G, node
// RealMemory=515306MB (~503G). `sbatch --mem=512G` fails at submit with
// "Requested node configuration is not available"; 502G schedules.
describe("effective memory ceilings", () => {
  it("clamps the nominal QOS mem to node RealMemory", () => {
    expect(effectiveMemPerNodeGb({ maxMemGb: 512, maxNodes: 1 }, 515306)).toBe(503);
    expect(effectiveJobMemGb({ maxMemGb: 512, maxNodes: 1 }, 515306)).toBe(503);
  });

  it("keeps the QOS cap when it is the tighter bound", () => {
    // DEF: 384G cap on 1.5T nodes
    expect(effectiveMemPerNodeGb({ maxMemGb: 384, maxNodes: 1 }, 1543224)).toBe(384);
  });

  it("stops --mem where Slurm would raise CPUs past the QoS core cap", () => {
    // GPU-1: 26 cores x MaxMemPerCPU 9845 MB = 249.97 GiB. Measured
    // 2026-10-01: --mem=249G -> 26 CPUs, runs; --mem=250G -> 52 CPUs, pends
    // on QOSMaxCpuPerJobLimit forever. The QoS mem=256G is never grantable.
    const gpu1 = { maxCores: 26, maxMemGb: 256, maxNodes: 1, maxMemPerCpuMb: 9845 };
    expect(effectiveMemPerNodeGb(gpu1, 515306)).toBe(249);
    expect(effectiveJobMemGb(gpu1, 515306)).toBe(249);
    // DEF: 64 x 6000 MB = 375 GiB, below QoS mem=384G
    expect(effectiveMemPerNodeGb({ maxCores: 64, maxMemGb: 384, maxNodes: 1, maxMemPerCpuMb: 6000 }, 1543224)).toBe(375);
  });

  it("does not invent a node limit the QoS doesn't have", () => {
    // live QoS small = cpu=768,mem=4.50T, no node= term; a 512-core SMALL
    // job ran on 20 nodes (2026-10-01). Only the QoS memory total binds.
    expect(effectiveJobMemGb({ maxCores: 768, maxMemGb: 4608 }, 1543224)).toBe(4608);
    expect(allowsMultiNode({ maxCores: 768, maxMemGb: 4608 }, 256)).toBe(true);
    // VM-CPU: no node limit either, but 32 cores fit one 32-core node
    expect(allowsMultiNode({ maxCores: 32, maxMemGb: 458 }, 32)).toBe(false);
    expect(allowsMultiNode({ maxCores: 64, maxNodes: 1 }, 256)).toBe(false);
  });

  it("scales the job-total ceiling by maxNodes", () => {
    // SMALL: QOS 4608G across 3 nodes, but 3×1507G is all the hardware has
    expect(effectiveJobMemGb({ maxMemGb: 4608, maxNodes: 3 }, 1543224)).toBe(4521);
    // per-node --mem stays bounded by one node regardless of the job total
    expect(effectiveMemPerNodeGb({ maxMemGb: 4608, maxNodes: 3 }, 1543224)).toBe(1507);
  });

  it("passes through when hardware is unknown", () => {
    expect(effectiveMemPerNodeGb({ maxMemGb: 512 }, undefined)).toBe(512);
    expect(effectiveJobMemGb({ maxMemGb: 512 }, undefined)).toBe(512);
    expect(effectiveJobMemGb({}, 515306)).toBeUndefined();
  });
});
