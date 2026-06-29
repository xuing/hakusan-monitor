import type { CpuSubmitProbe, Pool, Snapshot } from "@/types/snapshot";

export const CPU_POLICY_ORDER = ["TINY", "DEF", "SINGLE", "SMALL", "LARGE", "XLARGE", "X2LARGE", "LONG", "LONG-L"];

export type CpuProbeState = "now" | "queued" | "failed" | "unknown";

export interface CpuProbeRow {
  partition: string;
  probe: CpuSubmitProbe | null;
  cores: number;
  memMb: number;
  command: string;
}

export function cpuProbeRows(pool: Pool, snap: Snapshot): CpuProbeRow[] {
  const raw = snap.cpu_submit_probes ?? [];
  if (raw.length === 0) return [];
  const probes = new Map(raw.map((probe) => [probe.partition, probe]));
  return CPU_POLICY_ORDER
    .filter((partition) => pool.partitions.includes(partition))
    .map((partition) => cpuProbeRow(partition, probes.get(partition) ?? null));
}

export function cpuProbeRow(partition: string, probe: CpuSubmitProbe | null): CpuProbeRow {
  const cores = probe?.processors || cpuDefaultCores(partition);
  return {
    partition,
    probe,
    cores,
    memMb: cpuDefaultMemMb(partition, cores),
    command: `salloc -p ${partition}`,
  };
}

export function cpuProbeForPartition(snap: Snapshot, partition: string): CpuProbeRow | null {
  if ((snap.cpu_submit_probes ?? []).length === 0) return null;
  const probe = (snap.cpu_submit_probes ?? []).find((item) => item.partition === partition) ?? null;
  return probe || CPU_POLICY_ORDER.includes(partition) ? cpuProbeRow(partition, probe) : null;
}

export function cpuProbeState(probe: CpuSubmitProbe | null, generatedAt: number): CpuProbeState {
  if (!probe) return "unknown";
  if (!probe.ok) return "failed";
  if (!probe.start_epoch) return "queued";
  return probe.start_epoch <= generatedAt + 120 ? "now" : "queued";
}

export function cleanCpuProbeRaw(raw: string) {
  return raw
    .replace(/\bsbatch:\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cpuDefaultCores(partition: string) {
  return ["SMALL", "LARGE", "XLARGE", "X2LARGE", "LONG-L"].includes(partition) ? 256 : 16;
}

function cpuDefaultMemMb(partition: string, cores: number) {
  if (["SMALL", "LARGE", "XLARGE", "X2LARGE", "LONG-L"].includes(partition) || cores >= 256) return 1500 * 1024;
  return 96 * 1024;
}
