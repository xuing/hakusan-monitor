/**
 * One case per GPU display mode, each stating: real cluster data in, exact
 * dashboard output expected. Records live in gpu-availability.fixtures.ts with
 * their provenance; nothing here is hand-tuned to make a rule pass.
 *
 * Tests run the real pipeline — raw snapshot nodes through `gpuNodeFacts`,
 * then `gpuAvailability` — so an adapter bug fails here too.
 */
import { describe, expect, it } from "vitest";
import { gpuAvailability, gpuPerGpuNeed, type GpuAvailabilitySegment } from "./gpu-availability";
import { gpuNodeFacts } from "./gpu-fit";
import { capPerGpu } from "./slurm";
import {
  A100_DRAIN,
  A40_CPU_MEM_SHORT,
  A40_CPU_SHORT,
  A40_FREE_SLOT,
  A40_FULL,
  A40_MEM_SHORT,
  A40_PLANNED,
  CAP_GPU_1,
  CAP_VM_GPU_L,
  H100_ALLOCATED,
  H100_IDLE,
  NODES_H100,
  PENDING_A40_CONTENDER,
  PENDING_H100_LIMIT_BLOCKED,
  POOL_A100,
  POOL_A40,
  POOL_H100,
  REQUEST_GPU_1,
  REQUEST_GPU_1A,
  REQUEST_VM_GPU_L,
} from "./gpu-availability.fixtures";
import type { Pool, RawJob, RawNode } from "@/types/snapshot";
import type { PartitionCap } from "./slurm";

const NOW = Date.parse("2026-07-29T06:34:00+09:00");

function display(nodes: RawNode[], pool: Pool, request = REQUEST_GPU_1, cap: PartitionCap = CAP_GPU_1, pending: RawJob[] = []) {
  return gpuAvailability(gpuNodeFacts(nodes, pool, pending, NOW), request, capPerGpu(cap));
}

const segments = (result: { segments: GpuAvailabilitySegment[] }) => result.segments;

describe("per-GPU need — derived from Slurm's real defaults", () => {
  it("reproduces the measured GPU-1 default: 26 cores x 9845 MB", () => {
    // sbatch -H -p GPU-1 -> NumCPUs=26 MinMemoryCPU=9845M, on a 52-core /
    // 515306 MB / 2-GPU A40 node.
    expect(gpuPerGpuNeed(REQUEST_GPU_1, { gpus: 2, cores: 52, memMb: 515306 }, capPerGpu(CAP_GPU_1)))
      .toEqual({ partition: "GPU-1", gpus: 1, cores: 26, memMb: 255970 });
  });

  it("caps VM-GPU-L's 476800 MB default at the 469070 MB one H100 node holds", () => {
    // The request really does ask for more memory than a gl0x node has; Slurm
    // spreads it over two nodes rather than refusing. Per GPU, the ceiling is
    // the hardware share — the fix for the "3 idle nodes are memory-short" bug.
    expect(gpuPerGpuNeed(REQUEST_VM_GPU_L, { gpus: 1, cores: 32, memMb: 469070 }, capPerGpu(CAP_VM_GPU_L)))
      .toEqual({ partition: "VM-GPU-L", gpus: 1, cores: 32, memMb: 469070 });
  });

  it("never exceeds the QoS ceiling when policy is stricter than the default", () => {
    // Hypothetical tightening of gpu-1 to mem=64G: the request must shrink.
    expect(gpuPerGpuNeed(REQUEST_GPU_1, { gpus: 2, cores: 52, memMb: 515306 },
      capPerGpu({ maxGpus: 1, maxCores: 8, maxMemGb: 64 })))
      .toEqual({ partition: "GPU-1", gpus: 1, cores: 8, memMb: 65536 });
  });
});

describe("display mode: ready", () => {
  it("shows the three idle H100 nodes as 3 available GPUs", () => {
    // The reported bug. h100-80 at 06:34: gl01 fully allocated, gl[02-04]
    // completely empty. `salloc -p VM-GPU-L` started immediately that minute.
    const result = display(NODES_H100, POOL_H100, REQUEST_VM_GPU_L, CAP_VM_GPU_L);

    expect(segments(result)).toEqual([{ kind: "ready", count: 3 }]);
    expect(result.ready).toBe(3);
  });

  it("keeps them ready when the only waiter is limit-blocked", () => {
    // Job 499123 sits on VM-GPU-L under QOSMaxJobsPerUserLimit. It cannot
    // start, so it must not colour the free GPUs amber. `contendersForPool`
    // filters it upstream, which is why the list passed here is empty.
    const result = display(NODES_H100, POOL_H100, REQUEST_VM_GPU_L, CAP_VM_GPU_L, []);

    expect(segments(result)).toEqual([{ kind: "ready", count: 3 }]);
    expect(PENDING_H100_LIMIT_BLOCKED.state_reason).toBe("QOSMaxJobsPerUserLimit");
  });
});

describe("display mode: contested", () => {
  it("marks a takeable GPU amber while a startable waiter fits it", () => {
    // spcc-a40g15's leftovers with the reservation lifted, plus job 499329
    // (Reason=Resources, 26 cores / 1 GPU / 255970 MB) — it fits, so a new
    // request does not get the slot.
    const contender = { ...PENDING_A40_CONTENDER, sched_nodes: "" };
    const result = display([A40_FREE_SLOT], POOL_A40, REQUEST_GPU_1, CAP_GPU_1, [contender]);

    expect(segments(result)).toEqual([{ kind: "contested", count: 1 }]);
  });
});

describe("display mode: memory", () => {
  it("reports 1 GPU memory-blocked when the sibling job took the policy max", () => {
    // 515306 - 262144 = 253162 MB left, 2808 MB short of the 255970 MB
    // default request; 26 cores are free, so CPU is not the problem.
    const result = display([A40_MEM_SHORT], POOL_A40);

    expect(segments(result)).toEqual([{ kind: "memory", count: 1 }]);
    expect(result.nodes[0].missingMemMb).toBe(2808);
    expect(result.nodes[0].missingCores).toBe(0);
  });
});

describe("display mode: cpu", () => {
  it("reports 1 GPU CPU-blocked when a 40-core sibling leaves 12 cores", () => {
    const result = display([A40_CPU_SHORT], POOL_A40);

    expect(segments(result)).toEqual([{ kind: "cpu", count: 1 }]);
    expect(result.nodes[0].missingCores).toBe(14);
    expect(result.nodes[0].missingMemMb).toBe(0);
  });
});

describe("display mode: cpu-memory", () => {
  it("reports one state, not two, when a node is short on both", () => {
    // spcc-a40g14's real leftovers: 10 cores and 101816 MB.
    const result = display([A40_CPU_MEM_SHORT], POOL_A40);

    expect(segments(result)).toEqual([{ kind: "cpu-memory", count: 1 }]);
  });
});

describe("display mode: reserved", () => {
  it("shows spcc-a40g15's free GPU as scheduler-held, not as free capacity", () => {
    // PLANNED for job 499329. Its leftovers do fit the default request — the
    // reservation, not a shortage, is what makes it unavailable.
    const result = display([A40_PLANNED, A40_FULL], POOL_A40);

    expect(segments(result)).toEqual([{ kind: "reserved", count: 1 }]);
    expect(result.nodes[0].missingCores).toBe(0);
    expect(result.nodes[0].missingMemMb).toBe(0);
  });
});

describe("display mode: down", () => {
  it("shows spcc-a100g02's idle A100 as down while the node is DRAIN", () => {
    const result = display([A100_DRAIN], POOL_A100, REQUEST_GPU_1A);

    expect(segments(result)).toEqual([{ kind: "down", count: 1 }]);
  });
});

describe("display mode: full", () => {
  it("collapses to a single zero when no GPU in the pool is idle", () => {
    const result = display([A40_FULL], POOL_A40);

    expect(segments(result)).toEqual([{ kind: "full", count: 0 }]);
    expect(result.physicalIdle).toBe(0);
  });
});

describe("mixed pools", () => {
  it("orders states takeable-first and keeps them adding up to the total", () => {
    const nodes = [A40_FREE_SLOT, A40_MEM_SHORT, A40_CPU_SHORT, A40_PLANNED, A40_FULL];
    const result = display(nodes, POOL_A40);

    expect(segments(result)).toEqual([
      { kind: "ready", count: 1 },
      { kind: "memory", count: 1 },
      { kind: "cpu", count: 1 },
      { kind: "reserved", count: 1 },
    ]);
    const total = result.segments.reduce((sum, s) => sum + s.count, 0);
    expect(total).toBe(result.physicalIdle);
  });
});

describe("invariant: idle hardware is never called resource-short", () => {
  const empty: Array<[string, RawNode[], Pool, typeof REQUEST_GPU_1, PartitionCap]> = [
    ["h100-80", H100_IDLE, POOL_H100, REQUEST_VM_GPU_L, CAP_VM_GPU_L],
    ["a40", [{ ...A40_FREE_SLOT, alloc_cpus: 0, alloc_memory: 0, gres_used: "", state: ["IDLE"] }], POOL_A40, REQUEST_GPU_1, CAP_GPU_1],
  ];

  it.each(empty)("%s: a fully idle schedulable node is always ready", (_name, nodes, pool, request, cap) => {
    const result = display(nodes, pool, request, cap);

    expect(result.segments.every((s) => s.kind === "ready")).toBe(true);
    expect(result.ready).toBe(result.physicalIdle);
  });

  it("holds even when the default request exceeds one node's whole memory", () => {
    // VM-GPU-L asks 476800 MB; the node has 469070 MB and nothing running.
    // A rule that compares the raw request against free memory reports
    // "memory insufficient" here — that was the shipped bug.
    const idle = display(H100_IDLE, POOL_H100, REQUEST_VM_GPU_L, CAP_VM_GPU_L);

    expect(idle.nodes.every((n) => n.missingMemMb === 0 && n.missingCores === 0)).toBe(true);
    expect(H100_ALLOCATED.real_memory).toBeLessThan(REQUEST_VM_GPU_L.cores * REQUEST_VM_GPU_L.memPerCoreMb);
  });
});
