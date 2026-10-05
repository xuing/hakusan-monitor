import { describe, expect, it } from "vitest";
import { cpuProbeState, liveCpuStart } from "./cpu-probes";
import type { CpuSubmitProbe } from "@/types/snapshot";

const probe = (startEpoch: number): CpuSubmitProbe => ({
  partition: "SMALL",
  ok: true,
  start_time: "2026-07-10T10:00:00",
  start_epoch: startEpoch,
  processors: 256,
  nodes: "lcpcc-[001-003]",
  raw: "ok",
});

describe("cpuProbeState", () => {
  it("does not let a queued result turn into now as observation time advances", () => {
    expect(cpuProbeState(probe(2_000), 1_000, 1_050, 1_200)).toBe("queued");
    expect(cpuProbeState(probe(2_000), 1_000, 1_900, 1_200)).toBe("queued");
  });

  it("expires a previously-now result", () => {
    expect(cpuProbeState(probe(1_050), 1_000, 1_100, 1_200)).toBe("now");
    expect(cpuProbeState(probe(1_050), 1_000, 2_201, 1_200)).toBe("unknown");
  });
});

describe("liveCpuStart (measured 2026-10-05)", () => {
  const node = (name: string, alloc: number, part = "DEF") =>
    ({ name, partitions: [part], state: [alloc ? "MIXED" : "IDLE"], cpus: 256, alloc_cpus: alloc,
       real_memory: 1543224, alloc_memory: alloc * 6000, gres: "" });
  const job = (reason: string, part = "DEF") =>
    ({ job_state: "PENDING", partition: part, state_reason: reason, cpus: 16 });
  const snapOf = (nodes: object[], jobs: object[], extra: Record<string, unknown> = {}) => ({
    generated_at: 1000, nodes, jobs,
    policy: {
      partition_defaults: { DEF: { cores: 16, def_mem_per_cpu_mb: 6000 }, "VM-CPU": { cores: 32, def_mem_per_cpu_mb: 14656 } },
      partition_caps: { DEF: { maxNodes: 1 }, "VM-CPU": { maxNodes: 1 } },
      partition_policies: {},
      ...extra,
    },
  }) as unknown as Parameters<typeof liveCpuStart>[0];

  it("DEF starts now behind 62 QOSMaxJobsPerUserLimit jobs (test-only said 2 days)", () => {
    const jobs = Array.from({ length: 62 }, () => job("QOSMaxJobsPerUserLimit"));
    expect(liveCpuStart(snapOf([node("lcpcc-074", 200)], jobs), "DEF")).toBe("now");
  });

  it("VM-CPU starts now behind a Dependency job", () => {
    const vm = { name: "spcc-cld-07", partitions: ["VM-CPU"], state: ["IDLE"], cpus: 32, alloc_cpus: 0,
                 real_memory: 469070, alloc_memory: 0, gres: "" };
    expect(liveCpuStart(snapOf([vm], [job("Dependency", "VM-CPU")]), "VM-CPU")).toBe("now");
  });

  it("SINGLE: whole-node Priority waiters don't take a part-used node's 56 free cores", () => {
    const whole = Array.from({ length: 51 }, () => ({ ...job("Priority"), cpus: 256, node_count: 1 }));
    expect(liveCpuStart(snapOf([node("lcpcc-074", 200)], whole), "DEF")).toBe("now");
    expect(liveCpuStart(snapOf([node("idle", 0)], whole), "DEF")).toBe("queued");
  });

  it("a hand-set request gets the same verdict as the identical default", () => {
    const whole = Array.from({ length: 51 }, () => ({ ...job("Priority"), cpus: 256, node_count: 1 }));
    const s = snapOf([node("lcpcc-074", 200)], whole);
    expect(liveCpuStart(s, "DEF", { cores: 16 })).toBe(liveCpuStart(s, "DEF"));
    expect(liveCpuStart(s, "DEF", { cores: 56 })).toBe("now");
    expect(liveCpuStart(s, "DEF", { cores: 57 })).toBe("queued");
    expect(liveCpuStart(s, "DEF", { cores: 16, memMb: 400_000 })).toBe("queued");
  });

  it("queues when Priority/Resources waiters outnumber the free slots", () => {
    expect(liveCpuStart(snapOf([node("a", 200)], [job("Priority")]), "DEF")).toBe("queued");
    expect(liveCpuStart(snapOf([node("a", 250)], []), "DEF")).toBe("queued");
  });

  it("queues when the partition's group job cap is full", () => {
    const running = Array.from({ length: 3 }, () => ({ job_state: "RUNNING", partition: "DEF" }));
    const s = snapOf([node("a", 0)], running, { partition_policies: { DEF: { grpJobs: 3 } } });
    expect(liveCpuStart(s, "DEF")).toBe("queued");
  });
});
