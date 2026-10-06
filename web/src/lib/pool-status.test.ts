import { describe, expect, it } from "vitest";
import { poolPick, poolTone } from "./pool-status";
import type { Pool, Snapshot } from "@/types/snapshot";

// lcpcc-like pool: one 256-core node, DEF (general) and MS (license only)
function cpuSnap(allocCores: number, nodes = 1): { snap: Snapshot; pool: Pool } {
  const free = 256 - allocCores;
  const pool = {
    id: "cpu", kind: "cpu", nodes, down_nodes: 0, partitions: ["DEF", "MS"], mem_per_node: 1_543_224,
    cores: { total: 256 * nodes, alloc: allocCores * nodes, free: free * nodes },
  } as unknown as Pool;
  const snap = {
    generated_at: 1_000, jobs: [], pools: [pool], part_pool: { DEF: "cpu", MS: "cpu" }, licenses: [], cpu_submit_probes: [],
    partitions: [], nodes: Array.from({ length: nodes }, (_, i) => ({
      name: `lcpcc-${i}`, pool: "cpu", partitions: ["DEF", "MS"], state: [allocCores ? "MIXED" : "IDLE"], schedulable: true,
      cpus: 256, alloc_cpus: allocCores, real_memory: 1_543_224, alloc_memory: allocCores * 6000, gres: "", gres_used: "",
    })),
    policy: {
      partition_defaults: { DEF: { cores: 16, def_mem_per_cpu_mb: 6000 }, MS: { cores: 8, requires_license: true } },
      partition_caps: { DEF: { maxNodes: 1, maxCores: 64 }, MS: { maxNodes: 1 } },
      partition_policies: {},
    },
  } as unknown as Snapshot;
  return { snap, pool };
}

describe("poolTone: the dot, the border and the free count of a pool", () => {
  it("is green when a general partition's default request starts now", () => {
    const { snap, pool } = cpuSnap(200);   // 56 cores free: DEF's 16 fit
    expect(poolPick(snap, pool)?.partition).toBe("DEF");
    expect(poolTone(snap, pool)).toBe("ok");
  });

  it("is amber when cores are idle but no default request fits them", () => {
    // 8 cores free: DEF's 16 queue. A free-node count called this green while
    // the quick request beside it said "will queue".
    const { snap, pool } = cpuSnap(248);
    expect(poolTone(snap, pool)).toBe("warn");
  });

  it("is red when nothing is free, gray when every node is down", () => {
    expect(poolTone(cpuSnap(256).snap, cpuSnap(256).pool)).toBe("bad");
    const { snap, pool } = cpuSnap(0);
    expect(poolTone(snap, { ...pool, down_nodes: 1 })).toBe("off");
  });
});
