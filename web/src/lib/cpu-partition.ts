// One CPU partition's start verdict for a flagless request. The Overview
// quick-request table and the Partitions page both read cpuPartitionStatus,
// so the same partition never shows two different answers.
import type { TFn } from "@/i18n";
import { cpuProbeForPartition, cpuStartLimits, liveCpuStart, type CpuProbeRow, type CpuProbeState } from "@/lib/cpu-probes";
import { licenseBusy, licensePlan, type LicensePlan } from "@/lib/licenses";
import { cpuProbeLabel, cpuProbeTone } from "@/lib/policy-hints";
import { partitionDefaults, type Tone } from "@/lib/slurm";
import type { Snapshot } from "@/types/snapshot";

export interface CpuPartitionStatus {
  /** the partition's sbatch --test-only row, when it was probed */
  probe: CpuProbeRow | null;
  /** the flagless request: now / queued / failed / unknown */
  state: CpuProbeState;
  /** most cores a request with the default memory per core starts with now
   *  (0 = none); at least the default request when that starts */
  maxCores: number;
  /** maxCores needs several nodes */
  spread: boolean;
  /** maxCores is the default request Slurm's fresh probe starts, not what
   *  the live free slots hold */
  fromProbe: boolean;
  groupFull: boolean;
  license: LicensePlan;
  /** the flagless command this verdict is about; carries -L when the
   *  plugin's default license does not exist on the cluster ("fixed") */
  command: string;
  /** Slurm's start time for the flagless request, while it queues and that
   *  time is still ahead (a probe's "17:32" is no estimate at 17:37) */
  estimate: string | null;
}

export function cpuPartitionStatus(snap: Snapshot, partition: string): CpuPartitionStatus {
  const probe = cpuProbeForPartition(snap, partition);
  const defaults = partitionDefaults(partition, snap.policy);
  const license = licensePlan(defaults, snap.licenses ?? [], "", "");
  const live = liveCpuStart(snap, partition) ?? "unknown";
  // a partition that needs -L is never probed with its license: judge it live
  const state: CpuProbeState = license.flag ? live : probe?.state ?? live;
  const lim = cpuStartLimits(snap, partition);
  const groupFull = lim?.groupFull ?? false;
  const blocked = !lim || groupFull || licenseBusy(license);
  // Slurm's fresh "now" can place the default request where the live slots
  // can't (backfill into held nodes): the default then starts all the same
  const startable = state === "now" ? defaults.cores ?? probe?.cores ?? 0 : 0;
  const probedAt = snap.cpu_submit_probes_generated_at || snap.generated_at;
  const start = probe?.probe?.start_epoch ?? 0;
  const estimate = state === "queued" && probe?.probe?.start_time && start > probedAt + 120 && start > snap.generated_at
    ? probe.probe.start_time
    : null;
  return {
    probe,
    state,
    maxCores: blocked ? 0 : Math.max(lim!.maxCores, startable),
    spread: Boolean(lim?.spread) && (lim?.maxCores ?? 0) >= startable,
    fromProbe: !blocked && startable > (lim?.maxCores ?? 0),
    groupFull,
    license,
    command: `salloc -p ${partition}${license.kind === "fixed" ? ` ${license.flag}` : ""}`,
    estimate,
  };
}

/** The status tag for a CPU partition, the same on every page. */
export function cpuPartitionVerdict(s: CpuPartitionStatus, t: TFn): { tone: Tone; label: string } {
  if (s.license.kind === "required") return { tone: "bad", label: t("pool.needsL") };
  if (s.license.kind === "missing") return { tone: "bad", label: t("pool.verdictRejected") };
  if (licenseBusy(s.license) && s.state === "now") return { tone: "warn", label: t("pool.queueHintWillQueue") };
  return { tone: cpuProbeTone(s.state), label: cpuProbeLabel(s.state, t) };
}
