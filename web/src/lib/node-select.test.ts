import { describe, expect, it } from "vitest";
import { expandHostlist, parseGpuCount } from "./derive";
import { CAPTURE } from "./node-select.fixtures";
import { selectNodes, switchTable, type FreeNode, type NodeRequest } from "./node-select";

const BLOCKED = /^(DOWN|DRAIN|DRAINING|FAIL|FAILING|NOT_RESPONDING|MAINT|MAINTENANCE|POWERED_DOWN|POWERING_DOWN|REBOOT_ISSUED|REBOOT_REQUESTED|RESERVED)$/;
const TABLE = switchTable(CAPTURE.topology, expandHostlist);

/** The nodes of a partition a job could land on, in Slurm's node order. */
function freeNodes(partition: string): FreeNode[] {
  return CAPTURE.nodes
    .filter((n) => (n.partitions as readonly string[]).includes(partition) && !n.state.some((s) => BLOCKED.test(s)))
    .map((n) => {
      const type = /gpu:([^:(,]+):/.exec(n.gres)?.[1] ?? "";
      return {
        name: n.name, gpuType: type,
        cores: n.cpus - n.alloc_cpus,
        memMb: n.real_memory - n.alloc_memory,
        gpus: type ? parseGpuCount(n.gres, type) - parseGpuCount(n.gres_used, type) : 0,
      };
    });
}

/** The request Slurm saw: the probe's flags, the CPUs it reported, and the
 *  partition's DefMemPerCPU unless --mem-per-cpu was given. */
function requestOf(probe: (typeof CAPTURE.probes)[number]): NodeRequest {
  const flag = (re: RegExp) => Number(re.exec(probe.flags)?.[1] ?? 0);
  const cpt = flag(/-c (\d+)/) || 1;
  const tpn = flag(/--ntasks-per-node=(\d+)/);
  const gpus = flag(/--gres=gpu:(\d+)/) || (probe.partition.startsWith("GPU") ? 1 : 0);
  return {
    minNodes: flag(/-N (\d+)/) || 1, maxNodes: flag(/-N (\d+)/), tasks: flag(/-n (\d+)/) || probe.processors / cpt,
    cpus: probe.processors, cpusPerTask: cpt, tasksPerNode: tpn, minCpusNode: tpn ? tpn * cpt : cpt,
    memPerCpuMb: flag(/--mem-per-cpu=(\d+)/) || (CAPTURE.def_mem_per_cpu as Record<string, number>)[probe.partition] || 0,
    memPerNodeMb: 0, gpusPerNode: gpus, gpuType: "", required: [], excluded: [],
  };
}

describe(`node selection against sbatch --test-only (${CAPTURE.captured_at})`, () => {
  for (const probe of CAPTURE.probes.filter((p) => p.nodes && !p.partition.startsWith("GPU"))) {
    it(`-p ${probe.partition} ${probe.flags} -> ${probe.nodes}`, () => {
      const picked = selectNodes(freeNodes(probe.partition), requestOf(probe), TABLE);
      expect(picked?.map((t) => t.name).sort()).toEqual(expandHostlist(probe.nodes).sort());
      expect(picked?.reduce((sum, t) => sum + t.cpus, 0)).toBe(probe.processors);
    });
  }
});

/** Free cores and memory (in 6000 MB cores) of every CPU node with room, read
 *  by `scontrol` in the same ssh call that then submitted real 1-minute jobs
 *  (2026-10-07 01:45, cancelled at once). Node order is slurm.conf's. */
const BEFORE = "lcpcc-003 1 2;lcpcc-005 1 12;lcpcc-006 1 2;lcpcc-009 1 2;lcpcc-015 1 2;lcpcc-023 1 2;lcpcc-030 1 4;"
  + "lcpcc-032 1 2;lcpcc-052 1 2;lcpcc-056 16 17;lcpcc-057 16 17;lcpcc-063 13 14;lcpcc-072 18 19;lcpcc-074 32 33;"
  + "lcpcc-076 24 25;lcpcc-085 16 17;lcpcc-091 16 17;lcpcc-096 24 25;lcpcc-103 15 47;lcpcc-105 16 17;lcpcc-108 32 33;"
  + "lcpcc-111 46 47;lcpcc-123 1 2";
const before: FreeNode[] = BEFORE.split(";").map((row) => {
  const [name, cores, mem] = row.split(" ");
  return { name, cores: Number(cores), memMb: Number(mem) * 6000, gpus: 0, gpuType: "" };
});
const cpuJob = (over: Partial<NodeRequest>): NodeRequest => ({
  minNodes: 1, maxNodes: 0, tasks: 0, cpus: 0, cpusPerTask: 1, tasksPerNode: 0, minCpusNode: 1,
  memPerCpuMb: 6000, memPerNodeMb: 0, gpusPerNode: 0, gpuType: "", required: [], excluded: [], ...over,
});

describe("node selection against real jobs (sbatch -p SMALL, started and cancelled)", () => {
  it("-N 3 -n 48 (job 786356) got 16 cores on each of lcpcc-056, 057, 072", () => {
    // in node order 052 (1 core) and 063 (13) come first; with only 3 nodes
    // allowed they cannot reach 48, so Slurm drops the smallest and retries
    const picked = selectNodes(before, cpuJob({ minNodes: 3, maxNodes: 3, tasks: 48, cpus: 48 }), TABLE);
    expect(picked?.map((t) => `${t.name}:${t.cpus}`)).toEqual(["lcpcc-056:16", "lcpcc-057:16", "lcpcc-072:16"]);
  });
});
