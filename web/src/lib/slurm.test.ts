import { describe, expect, it } from "vitest";
import { effectiveJobMemGb, effectiveMemPerNodeGb } from "./slurm";

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
