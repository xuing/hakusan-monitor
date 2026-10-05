import { describe, expect, it } from "vitest";
import { cpuDefaultSpreads, cpuProbeState, cpuStartLimits, cpuStartMemMb, liveCpuStart } from "./cpu-probes";
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

describe("cpuStartLimits / cpuStartMemMb (the sliders' no-queue end)", () => {
  const node = (name: string, alloc: number, part = "SINGLE", allocMem = alloc * 6000) =>
    ({ name, partitions: [part], state: [alloc ? "MIXED" : "IDLE"], cpus: 256, alloc_cpus: alloc,
       real_memory: 1543224, alloc_memory: allocMem, gres: "" });
  const snapOf = (nodes: object[], jobs: object[] = [], caps: Record<string, unknown> = {}) => ({
    generated_at: 1000, nodes, jobs,
    policy: {
      partition_defaults: { SINGLE: { cores: 16, def_mem_per_cpu_mb: 6000 }, SMALL: { cores: 256, def_mem_per_cpu_mb: 6000 } },
      partition_caps: { SINGLE: { maxCores: 256, maxNodes: 1 }, SMALL: { maxCores: 768 }, ...caps },
      partition_policies: {},
    },
  }) as unknown as Parameters<typeof liveCpuStart>[0];

  it("single node: the largest free node, and the verdict flips exactly there", () => {
    const s = snapOf([node("a", 32), node("b", 200)]);
    const lim = cpuStartLimits(s, "SINGLE")!;
    expect(lim.maxCores).toBe(224);
    expect(liveCpuStart(s, "SINGLE", { cores: 224 })).toBe("now");
    expect(liveCpuStart(s, "SINGLE", { cores: 225 })).toBe("queued");
  });

  it("multi node: the sum over open nodes, capped by the QoS", () => {
    const parts = (n: string) => ({ ...node(n, 100), partitions: ["SMALL"] });
    const lim = cpuStartLimits(snapOf([parts("a"), parts("b"), parts("c"), parts("d"), parts("e"), parts("f")]), "SMALL")!;
    expect(lim.maxCores).toBe(768);   // 6 x 156 = 936 free, QoS 768
    expect(lim.spread).toBe(true);
  });

  it("follows -N and --mem the way liveCpuStart does", () => {
    const two = snapOf([{ ...node("a", 240), partitions: ["SMALL"] }, { ...node("b", 240), partitions: ["SMALL"] }]);
    // 16 + 16 free: 32 spread, but -N 1 holds only one node's 16
    expect(cpuStartLimits(two, "SMALL")!.maxCores).toBe(32);
    expect(cpuStartLimits(two, "SMALL", { nodes: 1 })!.maxCores).toBe(16);
    expect(liveCpuStart(two, "SMALL", { cores: 24, nodes: 1 })).toBe("queued");
    expect(cpuStartLimits(two, "SMALL", { nodes: 2 })!.maxCores).toBe(32);
    // an explicit small --mem frees cores DefMemPerCPU would not
    const tight = snapOf([node("c", 0, "SINGLE", 1_543_224 - 48_000)]);   // 48 000 MB free: 8 cores at 6000/core
    expect(cpuStartLimits(tight, "SINGLE")!.maxCores).toBe(8);
    expect(cpuStartLimits(tight, "SINGLE", { memMb: 1024 })!.maxCores).toBe(256);
    expect(liveCpuStart(tight, "SINGLE", { cores: 200, memMb: 1024 })).toBe("now");
  });

  it("memory: the largest free memory on a node that holds the cores", () => {
    const s = snapOf([node("a", 32, "SINGLE", 100_000), node("b", 200, "SINGLE", 1_000_000)]);
    expect(cpuStartMemMb(s, "SINGLE", 32)).toBe(1_443_224);    // node a: 224 cores free
    expect(cpuStartMemMb(s, "SINGLE", 230)).toBe(0);           // no node has 230 free
  });

  it("without -N an explicit --mem spreads too, and must fit every node used", () => {
    // 16 free cores on each; 100 000 MB and 300 000 MB free
    const two = snapOf([
      { ...node("a", 240, "SMALL", 1_443_224), partitions: ["SMALL"] },
      { ...node("b", 240, "SMALL", 1_243_224), partitions: ["SMALL"] },
    ]);
    expect(cpuStartMemMb(two, "SMALL", 24)).toBe(100_000);     // both nodes needed: the smaller free memory
    expect(cpuStartMemMb(two, "SMALL", 16)).toBe(300_000);     // node b alone holds 16
    expect(liveCpuStart(two, "SMALL", { cores: 24, memMb: 100_000 })).toBe("now");
    expect(liveCpuStart(two, "SMALL", { cores: 24, memMb: 100_001 })).toBe("queued");
    expect(cpuStartLimits(two, "SMALL", { memMb: 100_000 })!.maxCores).toBe(32);
    expect(cpuStartLimits(two, "SMALL", { memMb: 200_000 })!.maxCores).toBe(16);
  });

  it("knows when the default request has no single node to sit on", () => {
    const two = snapOf([{ ...node("a", 240), partitions: ["SMALL"] }, { ...node("b", 240), partitions: ["SMALL"] }]);
    expect(cpuDefaultSpreads(two, "SMALL", 24)).toBe(true);
    expect(cpuDefaultSpreads(two, "SMALL", 16)).toBe(false);
    expect(cpuDefaultSpreads(snapOf([node("c", 240)]), "SINGLE", 24)).toBe(false);   // single-node partition
  });

  it("reports a full group cap apart from the size limit", () => {
    const running = Array.from({ length: 2 }, () => ({ job_state: "RUNNING", partition: "SINGLE" }));
    const s = snapOf([node("a", 0)], running);
    (s.policy!.partition_policies as Record<string, unknown>).SINGLE = { grpJobs: 2 };
    const lim = cpuStartLimits(s, "SINGLE")!;
    expect(lim.groupFull).toBe(true);
    expect(lim.maxCores).toBe(256);
  });
});
