/**
 * One case per display mode of the top-users card, each stating: real
 * cluster data in, exact ranking out. Records live in user-usage.fixtures.ts
 * with their provenance; nothing here is tuned to make a rule pass.
 */
import { describe, expect, it } from "vitest";
import {
  A40_PENDING,
  A40_RUNNING,
  CPU_MEMORY_HOG,
  CPU_PENDING,
  CPU_RUNNING,
  H100_80_RUNNING,
  POOL_A40,
  POOL_CPU,
  VM_CPU_RUNNING,
  snapshotWith,
} from "./user-usage.fixtures";
import { fmtShare, groupUsage, poolTotals, poolUsage, topUsers } from "./user-usage";

const order = (users: { user: string }[]) => users.map((u) => u.user);

describe("pool totals — the bars' denominators", () => {
  it("counts the whole pool, down nodes included, with memory summed from the nodes", () => {
    // 20 A40 nodes × 52 cores / 2 GPUs / 515306 MB; 140 of the cores were on
    // drained nodes that minute and still count — the share is of the pool.
    expect(poolTotals(POOL_A40, snapshotWith([]).nodes)).toEqual({ cores: 1040, gpus: 40, memMb: 10_306_120 });
    expect(poolTotals(POOL_CPU, snapshotWith([]).nodes)).toEqual({ cores: 31_744, gpus: 0, memMb: 191_359_776 });
  });

  it("falls back to mem_per_node × nodes for a snapshot without node rows", () => {
    expect(poolTotals(POOL_CPU, []).memMb).toBe(1_543_224 * 124);
  });
});

describe("display mode: GPU pool (A40, every running job of 2026-10-05 16:37)", () => {
  const snap = snapshotWith([...A40_RUNNING, ...A40_PENDING]);
  const usage = poolUsage(snap, "a40")!;

  it("ranks by share of the pool's 40 GPUs, not by job count or cores", () => {
    expect(usage.unit).toBe("gpus");
    // s2410439 holds 6 GPUs with 156 cores, s2610205 6 GPUs with 72: equal
    // GPU share, cores break the tie. The 4-GPU group (phuongnm, s2510444,
    // s2410431) sorts by cores, then memory.
    expect(order(usage.users)).toEqual([
      "s2120038", "s2410439", "s2610205", "s2510460", "phuongnm", "s2510444", "s2410431", "s2510439", "s2420411",
    ]);
  });

  it("makes GPUs the headline for a user whose cores would rank lower", () => {
    // 7 of 40 GPUs (17.5%) with only 112 of 1040 cores (10.8%): the old card
    // (jobs, then cores) never showed this user at all.
    const top = usage.users[0];
    expect(top).toMatchObject({ user: "s2120038", running: 7, dominant: "gpus", held: { gpus: 7, cores: 112, memMb: 458_752 } });
    expect(top.shares.gpus).toBeCloseTo(0.175, 10);
    expect(top.shares.cores).toBeCloseTo(112 / 1040, 10);
    expect(fmtShare(top.shares.gpus)).toBe("18%");
  });

  it("prefers GPUs when a user's GPU and core shares tie exactly", () => {
    // 6 × (1 GPU + 26 cores) on 2-GPU / 52-core nodes: 15.0% of both.
    const u = usage.users.find((x) => x.user === "s2410439")!;
    expect(u.shares.gpus).toBe(u.shares.cores);
    expect(u.dominant).toBe("gpus");
  });

  it("carries each user's queued demand in the pool and the pool's waiter count", () => {
    const u = usage.users.find((x) => x.user === "s2610205")!;
    expect(u).toMatchObject({ pending: 15, queued: { gpus: 15, cores: 184, memMb: 1_507_328 } });
    // 37 waiters in the fixture: 8 + 15 from users who also run, 14 from s2510457
    expect(usage.pendingJobs).toBe(37);
  });

  it("lists only users who hold something: a queued-only user is not a row", () => {
    expect(order(usage.users)).not.toContain("s2510457");
  });

  it("folds everyone past the fifth row into one tail that still adds up to the pool", () => {
    const { shown, rest } = topUsers(usage, 5);
    expect(order(shown)).toEqual(["s2120038", "s2410439", "s2610205", "s2510460", "phuongnm"]);
    expect(rest).toEqual({ users: 4, running: 10, units: 12, share: 0.3 });
    // 28 GPUs on the five rows + 12 on the tail = the 40 GPUs Slurm reported in use
    expect(shown.reduce((s, u) => s + u.held.gpus, 0) + rest!.units).toBe(POOL_A40.gpu!.used);
  });

  it("counts a waiter listing partitions of two pools in both pools", () => {
    // 3 of s2610205's and all 14 of s2510457's waiters list GPU-1A next to
    // GPU-1/GPU-S: they wait for an A40 or an A100 alike (same rule as
    // pendingForPool). Nobody runs on the A100 in this fixture, so that pool
    // has waiters but no rows.
    const a100 = poolUsage(snap, "a100")!;
    expect(a100.users).toEqual([]);
    expect(a100.pendingJobs).toBe(17);
  });
});

describe("display mode: GPU pool with equal GPU shares (H100 80GB)", () => {
  it("breaks the 1-GPU-each tie on cores, then on memory", () => {
    // Three single-GPU jobs = 25% each; 32-core jobs ahead of the 24-core
    // one, and 468992 MB ahead of 438272 MB between the two 32-core jobs.
    const usage = poolUsage(snapshotWith(H100_80_RUNNING), "h100-80")!;
    expect(usage.users.map((u) => u.shares.gpus)).toEqual([0.25, 0.25, 0.25]);
    expect(order(usage.users)).toEqual(["s2420424", "s2410212", "s2320019"]);
  });
});

describe("display mode: CPU pool (ten lcpcc jobs, six users)", () => {
  const usage = poolUsage(snapshotWith([...CPU_RUNNING, ...CPU_PENDING]), "cpu")!;

  it("ranks by share of the 31,744 cores, with memory as the fallback dimension", () => {
    expect(usage.unit).toBe("cores");
    expect(order(usage.users)).toEqual(["hongo", "s2516105", "reno-h", "s2510033", "s2430412", "biovia"]);
    const hongo = usage.users[0];
    // 4096 + 256 + 256 cores; the 16-node job's 24,576,000 MB is its total over all nodes
    expect(hongo).toMatchObject({ running: 3, dominant: "cores", held: { cores: 4608, gpus: 0, memMb: 27_648_000 }, pending: 2, queued: { cores: 64 } });
    expect(fmtShare(hongo.shares.cores)).toBe("15%");
  });

  it("sums a multi-node MPI job once, by its own cpus and memory", () => {
    // two SMALL jobs on 18 and 8 nodes, 256 cores and 1,536,000 MB each
    expect(usage.users[1]).toMatchObject({ user: "s2516105", running: 2, held: { cores: 512, memMb: 3_072_000 } });
    expect(fmtShare(usage.users[1].shares.cores)).toBe("1.6%");
  });

  it("keeps a 2-core job visible as a share instead of rounding it to 0%", () => {
    const { rest } = topUsers(usage, 5);
    expect(rest).toMatchObject({ users: 1, running: 1, units: 2 });
    expect(fmtShare(rest!.share)).toBe("<0.1%");
  });
});

describe("display mode: memory-dominant user (derived from biovia's real job)", () => {
  it("ranks a 2-core job that pins a whole node's memory by that memory", () => {
    // biovia's 777850 with min_memory_mb = 1543224 (lcpcc-002's RealMemory):
    // 2 of 31,744 cores but 1 of 124 nodes' worth of memory.
    const jobs = CPU_RUNNING.map((j) => (j.user_name === "biovia" ? CPU_MEMORY_HOG : j));
    const usage = poolUsage(snapshotWith(jobs), "cpu")!;
    const biovia = usage.users.find((u) => u.user === "biovia")!;
    expect(biovia.dominant).toBe("mem");
    expect(biovia.shares.mem).toBeCloseTo(1 / 124, 10);
    expect(fmtShare(biovia.shares.mem)).toBe("0.8%");
    expect(order(usage.users)).toEqual(["hongo", "s2516105", "biovia", "reno-h", "s2510033", "s2430412"]);
  });
});

describe("display mode: overview groups (all GPU pools, all CPU pools)", () => {
  const snap = snapshotWith([...A40_RUNNING, ...H100_80_RUNNING, ...CPU_RUNNING, ...VM_CPU_RUNNING]);

  it("GPU: one ranking over every GPU pool; a pool wholly in maintenance adds no capacity", () => {
    const gpu = groupUsage(snap, "gpu")!;
    // A40 40 + A100 20 + H100 80GB 4; the 16 MIG slices were all down
    expect(gpu.totals.gpus).toBe(64);
    expect(gpu.pools.map((p) => p.id)).toEqual(["a40", "a100", "h100-80"]);
    const top = gpu.users[0];
    expect(top.dominant).toBe("gpus");
    // the breakdown names the pool each GPU sits in
    expect(Object.values(top.gpusByPool).reduce((a, b) => a + b, 0)).toBe(top.held.gpus);
  });

  it("CPU: the CPU pools summed, GPU jobs left out", () => {
    const cpu = groupUsage(snap, "cpu")!;
    expect(cpu.totals.cores).toBe(31_744 + 1_408 + 96);
    expect(cpu.users.every((u) => u.held.gpus === 0)).toBe(true);
    expect(cpu.users.map((u) => u.user)).toContain("s2510166");   // the VM-CPU job
  });

  it("no group without a running job", () => {
    expect(groupUsage(snapshotWith(A40_PENDING), "gpu")).toBeNull();
    expect(groupUsage(snapshotWith([]), "cpu")).toBeNull();
  });

  it("a pool in focus keeps its own one-user ranking", () => {
    const vm = poolUsage(snapshotWith(VM_CPU_RUNNING), "vm-cpu")!;
    expect(vm.users).toHaveLength(1);
    expect(vm.users[0]).toMatchObject({ user: "s2510166", dominant: "cores", held: { cores: 32, memMb: 468_992 } });
    expect(topUsers(vm, 5).rest).toBeNull();
  });
});

describe("privacy", () => {
  it("shows exactly the names the snapshot carries, so backend masking passes through", () => {
    // server.py masks snap.jobs[].user_name (first two characters + ***)
    // (first two characters + ***) when HM_MASK_USERS is on.
    const mask = (u: string) => (u.length > 2 ? `${u.slice(0, 2)}***` : "***");
    const masked = A40_RUNNING.map((j) => ({ ...j, user_name: mask(j.user_name) }));
    const names = order(poolUsage(snapshotWith(masked), "a40")!.users);
    expect(names.every((n) => n.endsWith("***"))).toBe(true);
    for (const raw of new Set(A40_RUNNING.map((j) => j.user_name))) expect(names).not.toContain(raw);
  });
});

describe("fmtShare", () => {
  it("rounds whole percents from 10% up, one decimal below, and never prints 0% for a holder", () => {
    expect(fmtShare(0)).toBe("0%");
    expect(fmtShare(2 / 31_744)).toBe("<0.1%");
    expect(fmtShare(64 / 31_744)).toBe("0.2%");
    expect(fmtShare(0.0994)).toBe("9.9%");
    expect(fmtShare(0.0995)).toBe("10%");
    expect(fmtShare(0.25)).toBe("25%");
    expect(fmtShare(1)).toBe("100%");
  });
});
