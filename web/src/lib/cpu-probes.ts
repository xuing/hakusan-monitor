import type { CpuSubmitProbe, Pool, Snapshot } from "@/types/snapshot";

export type CpuProbeState = "now" | "queued" | "failed" | "unknown";

export interface CpuProbeRow {
  partition: string;
  probe: CpuSubmitProbe | null;
  cores: number;
  command: string;
}

/** Probe rows for the partitions of one pool, in the backend's test order.
 * The backend (sources.CPU_TEST_PARTITIONS) decides which partitions get
 * probed — no second copy of that list lives here. */
export function cpuProbeRows(pool: Pool, snap: Snapshot): CpuProbeRow[] {
  return (snap.cpu_submit_probes ?? [])
    .filter((probe) => pool.partitions.includes(probe.partition))
    .map((probe) => cpuProbeRow(probe.partition, probe));
}

export function cpuProbeRow(partition: string, probe: CpuSubmitProbe | null): CpuProbeRow {
  return {
    partition,
    probe,
    cores: probe?.processors || 0,
    command: `salloc -p ${partition}`,
  };
}

export function cpuProbeForPartition(snap: Snapshot, partition: string): CpuProbeRow | null {
  const probe = (snap.cpu_submit_probes ?? []).find((item) => item.partition === partition) ?? null;
  return probe ? cpuProbeRow(partition, probe) : null;
}

export function cpuProbeState(
  probe: CpuSubmitProbe | null,
  probedAt: number,
  observedAt = probedAt,
  maxAge = 20 * 60,
): CpuProbeState {
  if (!probe) return "unknown";
  if (!probedAt || observedAt - probedAt > maxAge || observedAt < probedAt - 120) return "unknown";
  if (!probe.ok) return "failed";
  if (!probe.start_epoch) return "queued";
  // Judge the scheduler prediction at the instant it was tested. A queued
  // result must never turn green merely because later snapshots advance time.
  return probe.start_epoch <= probedAt + 120 ? "now" : "queued";
}

export function cpuProbeMaxAge(snap: Snapshot) {
  return (snap.cpu_submit_probe_interval ?? 900) + 300;
}

export function cleanCpuProbeRaw(raw: string) {
  return raw
    .replace(/\bsbatch:\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
