import { describe, expect, it } from "vitest";
import type { TFn } from "@/i18n";
import { cpuPartitionStatus, cpuPartitionVerdict } from "@/lib/cpu-partition";
import type { Snapshot } from "@/types/snapshot";

const t = ((key: string) => key) as TFn;
const node = (alloc: number) => ({ name: "lcpcc-003", partitions: ["TINY", "MS"], state: ["MIXED"], schedulable: true,
  cpus: 256, alloc_cpus: alloc, real_memory: 1543224, alloc_memory: 0, gres: "" });
const snapOf = (alloc: number, probeAt: number, now: number) => ({
  generated_at: now, cpu_submit_probes_generated_at: probeAt, nodes: [node(alloc)], jobs: [], licenses: [],
  cpu_submit_probes: [{ partition: "TINY", ok: true, start_time: "2026-10-06T17:41:00", start_epoch: probeAt + 1,
                        processors: 16, nodes: "lcpcc-003", raw: "" }],
  policy: {
    partition_defaults: { TINY: { cores: 16, def_mem_per_cpu_mb: 6000 }, MS: { cores: 8, requires_license: true } },
    partition_caps: { TINY: { maxNodes: 1, maxCores: 16 }, MS: { maxNodes: 1 } }, partition_policies: {},
  },
}) as unknown as Snapshot;

describe("cpuPartitionStatus", () => {
  it("counts the default request as startable when a fresh probe starts it", () => {
    // 13 free cores: the live slots can't hold 16, Slurm placed it anyway
    const s = cpuPartitionStatus(snapOf(243, 1_000, 1_100), "TINY");
    expect(s.state).toBe("now");
    expect(s.maxCores).toBe(16);
    expect(s.fromProbe).toBe(true);    // no "emptiest node" hint on this count
    expect(cpuPartitionVerdict(s, t).tone).toBe("ok");
  });

  it("names no start time once Slurm's estimate is past", () => {
    const s = cpuPartitionStatus(snapOf(243, 1_000, 1_400), "TINY");
    expect(s.state).toBe("queued");
    expect(s.estimate).toBeNull();
  });

  it("says -L is needed for a license-only partition", () => {
    expect(cpuPartitionVerdict(cpuPartitionStatus(snapOf(0, 1_000, 1_100), "MS"), t)).toEqual({ tone: "bad", label: "pool.needsL" });
  });

  it("takes the count from the live slots when they hold more than the default", () => {
    // 27 free cores on one node, default 16: 27 can start, below a 64-core cap
    const snap = snapOf(229, 1_000, 1_400);
    (snap.policy!.partition_caps as Record<string, object>).TINY = { maxNodes: 1, maxCores: 64 };
    const s = cpuPartitionStatus(snap, "TINY");
    expect(s.maxCores).toBe(27);
    expect(s.fromProbe).toBe(false);
  });
});
