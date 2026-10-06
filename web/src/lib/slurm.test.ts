import { describe, expect, it } from "vitest";
import { fmtCapMem } from "./policy-hints";
import {
  allowsMultiNode,
  defaultRequestSec,
  effectiveJobMemGb,
  effectiveMemPerNodeGb,
  fmtWallMinutes,
  interactiveForcedLabel,
  interactiveForcedSec,
  minutesToSlurmTime,
} from "./slurm";
import type { PolicySnapshot } from "@/types/snapshot";

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

// Live policy block, 2026-10-01 (job_submit.lua sha d21dc093ba03 + sacctmgr).
// The frontend owns none of these numbers: every test below feeds them in.
const POLICY: PolicySnapshot = {
  generated_at: 0,
  interval: 86400,
  partition_caps: {
    "GPU-1": { maxCores: 26, maxMemGb: 256, maxGpus: 1, maxNodes: 1, wall: "7d" },
    "GPU-S": { maxCores: 52, maxMemGb: 512, maxGpus: 2, maxNodes: 1, wall: "5d" },
    "GPU-L": { maxCores: 208, maxMemGb: 2048, maxGpus: 8, wall: "3d" },
    "GPU-1A": { maxCores: 26, maxMemGb: 256, maxNodes: 1, wall: "7d" },
    "GPU-LA": { maxCores: 208, maxMemGb: 2048, wall: "3d" },
    TINY: { maxCores: 16, maxMemGb: 96, maxNodes: 1, wall: "30m" },
    DEF: { maxCores: 64, maxMemGb: 384, maxNodes: 1, wall: "7d" },
  },
  partition_policies: {},
  partition_defaults: {
    "GPU-1": { cores: 26, gpus_per_node: 1, gpu_request_respected: true, interactive_time_min: 720 },
    "GPU-S": { cores: 26, gpus_per_node: 1, gpu_request_respected: true, interactive_time_min: 720 },
    "GPU-L": { cores: 26, gpus_per_node: 1, gpu_request_respected: true, interactive_time_min: 720 },
    "GPU-1A": { cores: 26, gpus_per_node: 1, gpu_request_respected: true, interactive_time_min: 720 },
    "GPU-LA": { cores: 26, gpus_per_node: 1, gpu_request_respected: true, interactive_time_min: 720 },
    TINY: { cores: 16 },
    DEF: { cores: 16, interactive_time_min: 2880 },
  },
};

describe("plugin-forced interactive walltime", () => {
  it("reads the pinned minutes per partition from the policy", () => {
    expect(interactiveForcedSec("GPU-1", POLICY)).toBe(720 * 60);
    expect(interactiveForcedSec("DEF", POLICY)).toBe(2880 * 60);
    expect(interactiveForcedLabel("GPU-1", POLICY)).toBe("12h");
    expect(interactiveForcedLabel("DEF", POLICY)).toBe("2d");
  });

  it("treats an absent rule as 'honours -t', never as a remembered constant", () => {
    expect(interactiveForcedSec("TINY", POLICY)).toBeNull();
    expect(interactiveForcedLabel("TINY", POLICY)).toBeNull();
    // no policy at all (mock mode / cold cache): nothing is forced
    expect(interactiveForcedSec("GPU-1", undefined)).toBeNull();
    expect(interactiveForcedSec("DEF", { ...POLICY, partition_defaults: undefined })).toBeNull();
  });

  it("labels any minute count sensibly", () => {
    expect(fmtWallMinutes(720)).toBe("12h");
    expect(fmtWallMinutes(2880)).toBe("2d");
    expect(fmtWallMinutes(90)).toBe("1h30m");
    expect(fmtWallMinutes(30)).toBe("30m");
    expect(fmtWallMinutes(1440)).toBe("1d");
    expect(minutesToSlurmTime(720)).toBe("12:00:00");
    expect(minutesToSlurmTime(2880)).toBe("2-00:00:00");
    expect(minutesToSlurmTime(90)).toBe("01:30:00");
  });

  it("judges a default request by the pinned walltime, else the QoS wall", () => {
    expect(defaultRequestSec("GPU-1", POLICY)).toBe(720 * 60);
    expect(defaultRequestSec("TINY", POLICY)).toBe(30 * 60);
    expect(defaultRequestSec("GPU-1", undefined)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("per-node memory a node's cores can carry (2026-10-01 boundary probes)", () => {
  it("GPU-L stops at 52 x 9845 MB = 499 GiB, not the node's 503", () => {
    // --mem=503G -> Slurm raised the job to 78 CPUs on a 52-core node (never
    // starts); --mem=499G -> 52 CPUs on one node.
    expect(effectiveMemPerNodeGb({ maxCores: 208, maxMemGb: 2048, maxMemPerCpuMb: 9845 }, 515306, 52)).toBe(499);
  });

  it("SMALL stops at 256 x 6000 MB = 1500 GiB, not the node's 1507", () => {
    // --mem=1507G spilled onto a second 256-core node (512 CPUs); 1500G fits one.
    expect(effectiveMemPerNodeGb({ maxCores: 768, maxMemGb: 4608, maxMemPerCpuMb: 6000 }, 1543224, 256)).toBe(1500);
  });
});

describe("memory limits are shown exactly, never rounded up", () => {
  it("prints GiB unless the value is a whole number of TiB", () => {
    expect(fmtCapMem(1500)).toMatch(/^1,?500GiB$/);   // once "1.5TiB" = 1536 GiB
    expect(fmtCapMem(4500)).toMatch(/^4,?500GiB$/);   // once "4.4TiB"
    expect(fmtCapMem(2048)).toBe("2TiB");
    expect(fmtCapMem(499)).toBe("499GiB");
  });
});
