import { CopyButton } from "@/components/common/copy-button";
import { Empty } from "@/components/common/empty";
import { HoverHint } from "@/components/common/hover-hint";
import { GpuReleaseHint } from "@/components/common/gpu-release-hint";
import { SectionCard } from "@/components/common/section-card";
import { LivePending } from "@/components/common/live-pending";
import { PolicyLimitChips } from "@/components/common/policy-limit-chips";
import { Tag } from "@/components/common/tag";
import { useLive } from "@/hooks/live-context";
import { useResourceFilter } from "@/hooks/resource-filter-context";
import { poolLabel, useT, type TFn } from "@/i18n";
import type { TranslationKey } from "@/i18n/en";
import { poolCapacity, type PoolCapacity } from "@/lib/derive";
import { clockOf, fmtMB, nf } from "@/lib/format";
import { contendersForPool, fitHasClearSlot, gpuStrandedCount } from "@/lib/gpu-fit";
import { gpuPartitionAdvice, type GpuPartitionAdvice } from "@/lib/gpu-advice";
import { cpuProbeForPartition, cpuProbeMaxAge, cpuProbeState, type CpuProbeRow } from "@/lib/cpu-probes";
import {
  cpuProbeDetail,
  cpuProbeLabel,
  cpuProbeTone,
  fmtPolicyLimit,
  policyLimitRows,
} from "@/lib/policy-hints";
import {
  isMaterialsStudioPartition,
  interactiveForcedSec,
  matchPartition,
  partitionCap,
  partitionPolicy as slurmPartitionPolicy,
  type PartitionCap,
} from "@/lib/slurm";
import { cn } from "@/lib/utils";
import type { Partition, PolicySnapshot, Pool } from "@/types/snapshot";

const POLICY_I18N_KEYS: Record<string, { title: TranslationKey; desc: TranslationKey }> = {
  DEF: { title: "policy.DEF", desc: "policy.DEF.desc" },
  TINY: { title: "policy.TINY", desc: "policy.TINY.desc" },
  SINGLE: { title: "policy.SINGLE", desc: "policy.SINGLE.desc" },
  LONG: { title: "policy.LONG", desc: "policy.LONG.desc" },
  SMALL: { title: "policy.SMALL", desc: "policy.SMALL.desc" },
  LARGE: { title: "policy.LARGE", desc: "policy.LARGE.desc" },
  XLARGE: { title: "policy.XLARGE", desc: "policy.XLARGE.desc" },
  X2LARGE: { title: "policy.X2LARGE", desc: "policy.X2LARGE.desc" },
  "LONG-L": { title: "policy.LONG-L", desc: "policy.LONG-L.desc" },
  MS_Castep: { title: "policy.MS_Castep", desc: "policy.MS_Castep.desc" },
  MS_Dmol3: { title: "policy.MS_Dmol3", desc: "policy.MS_Dmol3.desc" },
  MS_Forcite: { title: "policy.MS_Forcite", desc: "policy.MS_Forcite.desc" },
  MS_Compass: { title: "policy.MS_Compass", desc: "policy.MS_Compass.desc" },
  MS_Dftbplus: { title: "policy.MS_Dftbplus", desc: "policy.MS_Dftbplus.desc" },
  MS_Amorphous: { title: "policy.MS_Amorphous", desc: "policy.MS_Amorphous.desc" },
  MatStudio: { title: "policy.MatStudio", desc: "policy.MatStudio.desc" },
  "GPU-1": { title: "policy.GPU-1", desc: "policy.GPU-1.desc" },
  "GPU-S": { title: "policy.GPU-S", desc: "policy.GPU-S.desc" },
  "GPU-L": { title: "policy.GPU-L", desc: "policy.GPU-L.desc" },
  "GPU-1A": { title: "policy.GPU-1A", desc: "policy.GPU-1A.desc" },
  "GPU-LA": { title: "policy.GPU-LA", desc: "policy.GPU-LA.desc" },
  "VM-CPU": { title: "policy.VM-CPU", desc: "policy.VM-CPU.desc" },
  "VM-GPU-L": { title: "policy.VM-GPU-L", desc: "policy.VM-GPU-L.desc" },
  "VM-LM": { title: "policy.VM-LM", desc: "policy.VM-LM.desc" },
  i112: { title: "policy.i112", desc: "policy.i112.desc" },
};

function partitionLabelPolicy(name: string): { title: TranslationKey; desc: TranslationKey } {
  return POLICY_I18N_KEYS[name] ?? { title: "policy.other", desc: "policy.other.desc" };
}

function isMaintPartition(p: Partition) {
  const down = (p.nodes_state.down ?? 0) + (p.nodes_state.drain ?? 0);
  return down >= p.nodes && p.nodes > 0;
}

function availableNodes(p: Partition) {
  return p.available_nodes ?? p.free_nodes ?? 0;
}

// ---- the hero metric: what you can realistically request right now -----------
// GPU jobs are bounded by free cards; single-node CPU jobs by the emptiest node;
// multi-node CPU jobs by free *whole* nodes (they need contiguous nodes to start).
type Hero = { n: number; unit: "cores" | "gpu" | "nodes"; capped: boolean };

function requestableNow(p: Partition, cap: PartitionCap, isGpu: boolean, pc: PoolCapacity, gpuSchedulable: number | null, probeCores?: number): Hero {
  if (isGpu) {
    const free = p.gpu?.free ?? 0;
    // agree with the Overview verdict: a free GPU stranded on a node whose
    // leftover CPU/mem can't host the default request is NOT requestable
    const sched = Math.min(gpuSchedulable ?? free, free);
    return { n: Math.min(cap.maxGpus ?? sched, sched), unit: "gpu", capped: false };
  }
  // A real `sbatch --test-only` probe already reports the exact core count
  // Slurm will hand out — trust it over a derived "N idle whole nodes"
  // guess. These partitions carry no --exclusive requirement, so a
  // multi-node default request happily scatters across nodes that are
  // already mostly full, as long as SOME cores are free on each (verified
  // live: SMALL/LONG-L default requests landed on nodes already ~85-95%
  // loaded by unrelated jobs) — "N 台整空节点" promises exclusivity the
  // scheduler never guaranteed.
  if (probeCores) {
    return { n: probeCores, unit: "cores", capped: cap.maxCores !== undefined && probeCores < cap.maxCores };
  }
  if ((cap.maxNodes ?? 1) > 1) {
    // no probe data yet (e.g. backend just restarted) — fall back to the
    // coarser idle-node estimate
    return { n: Math.min(cap.maxNodes ?? pc.idleNodes, pc.idleNodes), unit: "nodes", capped: false };
  }
  const limit = cap.maxCores ?? pc.emptiestNodeFree;
  const n = Math.min(limit, pc.emptiestNodeFree);
  return { n, unit: "cores", capped: cap.maxCores !== undefined && n < cap.maxCores };
}

function heroText(t: TFn, h: Hero): string {
  if (h.unit === "gpu") return `${nf(h.n)} ${t("unit.gpu")}`;
  // "0 台整空节点" reads like a contradiction next to the queue tag — say it in words
  if (h.unit === "nodes") return h.n > 0 ? `${nf(h.n)} ${t("part.wholeNodes")}` : t("part.noWholeNodes");
  return `${nf(h.n)}c`;
}

export function PartitionPressure() {
  const { snap } = useLive();
  const { filter } = useResourceFilter();
  const t = useT();
  if (!snap) {
    return (
      <LivePending fallback={<SectionCard bodyClassName="pt-4">
        <div className="space-y-3">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="h-16 animate-pulse rounded-lg bg-muted/40" />
          ))}
        </div>
      </SectionCard>} />
    );
  }

  const matched = snap.partitions.filter((p) => matchPartition(p, filter));
  // Group by hardware pool; app-specific partitions remain under the same pool.
  const groups = new Map<string, PartitionGroup>();
  for (const p of matched) {
    const poolKey = p.pool ?? "other";
    const group = groups.get(poolKey) ?? { key: poolKey, poolKey, parts: [] };
    group.parts.push(p);
    groups.set(poolKey, group);
  }
  const order = snap.pools.map((p) => p.id);
  const poolById = new Map(snap.pools.map((p) => [p.id, p]));
  const partitionGroups = [...groups.values()].sort((a, b) =>
    Number(!!poolById.get(a.poolKey)?.gpu?.maint) - Number(!!poolById.get(b.poolKey)?.gpu?.maint)
      || order.indexOf(a.poolKey) - order.indexOf(b.poolKey),
  );

  return (
    <SectionCard bodyClassName="pt-4">
      {partitionGroups.length === 0 ? (
        <Empty>—</Empty>
      ) : (
        <div className="space-y-5">
          {partitionGroups.map((group) => {
            const cpuRank = (p: Partition) => {
              if (p.kind === "gpu") return 0;
              const runtimePolicy = slurmPartitionPolicy(p.name, snap.policy);
              if (runtimePolicy.grpJobs && p.jobs.running >= runtimePolicy.grpJobs) return 1;
              const row = cpuProbeForPartition(snap, p.name);
              if (!row) return 0;
              const state = cpuProbeState(
                row.probe,
                snap.cpu_submit_probes_generated_at || snap.generated_at,
                snap.generated_at,
                cpuProbeMaxAge(snap),
              );
              if (state === "now") return 0;
              if (state === "queued") return 2;
              if (state === "unknown") return 3;
              return 4;
            };
            const parts = group.parts.sort((a, b) =>
              Number(isMaintPartition(a)) - Number(isMaintPartition(b))
                || cpuRank(a) - cpuRank(b)
                || availableNodes(b) - availableNodes(a)
                || b.pressure - a.pressure,
            );
            const generalParts = parts.filter((p) => !isMaterialsStudioPartition(p.name));
            const materialsParts = parts.filter((p) => isMaterialsStudioPartition(p.name));
            const spec = parts[0].spec;
            const isGpu = parts[0].kind === "gpu";
            const pool = poolById.get(group.poolKey);
            const pc = poolCapacity(snap, group.poolKey);
            const pendingActive = isGpu ? contendersForPool(snap, group.poolKey) : [];
            const nowMs = Date.now();
            const gpuAdviceByPartition = new Map(
              isGpu && pool
                ? parts.map((p) => [
                    p.name,
                    gpuPartitionAdvice(
                      snap,
                      pool,
                      p.name,
                      pendingActive,
                      nowMs,
                      interactiveForcedSec(p.name, true) ?? Number.POSITIVE_INFINITY,
                    ),
                  ] as const)
                : [],
            );
            // "green" for the pool bar = the best any single sibling policy could
            // actually grant right now — matches the per-row rule: one partition
            // able to default-request it is enough to count it as available.
            const gpuSchedulableMax = isGpu && pool
              ? Math.max(0, ...parts.map((sp) => gpuAdviceByPartition.get(sp.name)?.fit.schedulable ?? 0))
              : undefined;
            return (
              <div key={group.key}>
                <PoolHeader
                  pool={pool}
                  label={poolLabel(t, group.poolKey)}
                  spec={spec}
                  isGpu={isGpu}
                  pc={pc}
                  gpuSchedulable={gpuSchedulableMax}
                  generatedAt={snap.generated_at}
                  t={t}
                />
                {parts.length > 1 && <p className="mb-1.5 text-xs text-muted-foreground/80">{t("part.shared")}</p>}
                <div className="space-y-2">
                  {generalParts.length > 0 && (
                    <PartitionRows
                      label={materialsParts.length > 0 ? t("part.generalCpuPolicies") : ""}
                      parts={generalParts}
                      isGpu={isGpu}
                      pc={pc}
                      cpuProbeFor={(p) => (!isGpu ? cpuProbeForPartition(snap, p.name) : null)}
                      gpuSlotsFor={(p) =>
                        gpuAdviceByPartition.get(p.name)?.fit.schedulable ?? null
                      }
                      gpuClearFor={(p) =>
                        gpuAdviceByPartition.has(p.name)
                          ? fitHasClearSlot(gpuAdviceByPartition.get(p.name)!.fit, pendingActive, nowMs, 720 * 60)
                          : null
                      }
                      gpuStrandedFor={(p) => {
                        const advice = gpuAdviceByPartition.get(p.name);
                        return advice ? gpuStrandedCount(advice.fit) : 0;
                      }}
                      gpuAdviceFor={(p) => gpuAdviceByPartition.get(p.name) ?? null}
                      probeGeneratedAt={snap.cpu_submit_probes_generated_at || snap.generated_at}
                      observedAt={snap.generated_at}
                      probeMaxAge={cpuProbeMaxAge(snap)}
                      policy={snap.policy}
                      t={t}
                    />
                  )}
                  {materialsParts.length > 0 && (
                    <PartitionRows
                      label={t("part.materialsStudioGroup")}
                      note={t("part.materialsStudioNote")}
                      parts={materialsParts}
                      isGpu={isGpu}
                      pc={pc}
                      cpuProbeFor={(p) => (!isGpu ? cpuProbeForPartition(snap, p.name) : null)}
                      gpuSlotsFor={() => null}
                      gpuClearFor={() => null}
                      gpuStrandedFor={() => 0}
                      gpuAdviceFor={() => null}
                      probeGeneratedAt={snap.cpu_submit_probes_generated_at || snap.generated_at}
                      observedAt={snap.generated_at}
                      probeMaxAge={cpuProbeMaxAge(snap)}
                      policy={snap.policy}
                      t={t}
                    />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </SectionCard>
  );
}

interface PartitionGroup {
  key: string;
  poolKey: string;
  parts: Partition[];
}

function PartitionRows({
  label,
  note,
  parts,
  isGpu,
  pc,
  cpuProbeFor,
  gpuSlotsFor,
  gpuClearFor,
  gpuStrandedFor,
  gpuAdviceFor,
  probeGeneratedAt,
  observedAt,
  probeMaxAge,
  policy,
  t,
}: {
  label: string;
  note?: string;
  parts: Partition[];
  isGpu: boolean;
  pc: PoolCapacity;
  cpuProbeFor: (p: Partition) => CpuProbeRow | null;
  gpuSlotsFor: (p: Partition) => number | null;
  gpuClearFor: (p: Partition) => boolean | null;
  gpuStrandedFor: (p: Partition) => number;
  gpuAdviceFor: (p: Partition) => GpuPartitionAdvice | null;
  probeGeneratedAt: number;
  observedAt: number;
  probeMaxAge: number;
  policy?: PolicySnapshot;
  t: TFn;
}) {
  return (
    <div>
      {label && (
        <div className="mb-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs">
          <span className="font-medium text-foreground">{label}</span>
          {note && <span className="text-muted-foreground/80">{note}</span>}
        </div>
      )}
      <div className="divide-y divide-border">
        {parts.map((p) => (
          <PartitionRow
            key={p.name}
            p={p}
            isGpu={isGpu}
            pc={pc}
            cpuProbe={cpuProbeFor(p)}
            gpuSchedulable={gpuSlotsFor(p)}
            gpuClear={gpuClearFor(p)}
            gpuStranded={gpuStrandedFor(p)}
            gpuAdvice={gpuAdviceFor(p)}
            probeGeneratedAt={probeGeneratedAt}
            observedAt={observedAt}
            probeMaxAge={probeMaxAge}
            policy={policy}
            t={t}
          />
        ))}
      </div>
    </div>
  );
}

function PoolHeader({
  pool,
  label,
  spec,
  isGpu,
  pc,
  gpuSchedulable,
  generatedAt,
  t,
}: {
  pool?: Pool;
  label: string;
  spec: Partition["spec"];
  isGpu: boolean;
  pc: PoolCapacity;
  gpuSchedulable?: number;
  generatedAt: number;
  t: TFn;
}) {
  const maint = isGpu && !!pool?.gpu?.maint;
  // every number is self-labelled: which dimension is "used", and used/total in raw units.
  const used = isGpu ? pool?.gpu?.used ?? 0 : pool?.cores.alloc ?? 0;
  const total = isGpu ? pool?.gpu?.total ?? 0 : pool?.cores.total ?? 0;
  const util = total ? used / total : 0;
  const unit = isGpu ? t("unit.gpu") : t("unit.cores");
  const dim = isGpu ? t("dim.gpu") : t("dim.cpu");
  const downNodes = pool?.down_nodes ?? ((pool?.nodes_state.down ?? 0) + (pool?.nodes_state.drain ?? 0));
  const availableNodeCount = pool?.available_nodes ?? pool?.idle_nodes ?? 0;
  const busyNodes = Math.max((pool?.nodes ?? 0) - availableNodeCount - downNodes, 0);
  const blocks = isGpu
    ? {
        free: pool?.gpu?.free ?? 0,
        used: pool?.gpu?.used ?? 0,
        reserved: pool?.gpu?.reserved ?? 0,
        down: pool?.gpu?.down ?? 0,
        total: pool?.gpu?.total ?? 0,
        unit: t("unit.gpu"),
      }
    : {
        free: availableNodeCount,
        used: busyNodes,
        reserved: 0,
        down: downNodes,
        total: pool?.nodes ?? 0,
        unit: t("spec.nodes"),
      };
  return (
    <div className="mb-1.5 border-b border-border pb-1.5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-sm font-semibold">{label}</span>
          <span className="font-mono text-xs text-muted-foreground">
            {nf(pool?.nodes ?? 0)} {t("spec.nodes")} · {t("spec.perNode")}{" "}
            {spec.gpu_per_node > 0 && `${spec.gpu_per_node} GPU · `}
            {spec.cores_per_node}c · {fmtMB(spec.mem_per_node)}
          </span>
        </div>
        {isGpu && <GpuReleaseHint next={pool?.gpu?.next_free} generatedAt={generatedAt} />}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <UnitBlocks {...blocks} schedulable={isGpu ? gpuSchedulable : undefined} />
        {maint ? (
          <>
            <Tag tone="neutral">{t("pool.maint")}</Tag>
            <span>{t("pool.offline", { n: nf(pool?.gpu?.down ?? total) })}</span>
          </>
        ) : (
          <>
            <span className="font-mono">
              {dim} {Math.round(util * 100)}% {t("kpi.used")} ({nf(used)}/{nf(total)} {unit})
            </span>
            <span>·</span>
            {isGpu ? (
              <span className="font-mono text-ok-fg">{nf(pool?.gpu?.free ?? 0)} {unit} {t("part.available")}</span>
            ) : pc.idleNodes > 0 ? (
              <>
                <span className="font-mono">{t("pool.idleNodes", { n: pc.idleNodes })}</span>
                <span>·</span>
                <span className="font-mono text-ok-fg">{nf(pc.freeCores)} {unit} {t("part.available")}</span>
              </>
            ) : (
              // no whole node is empty — say so, so "N cores free" doesn't look contradictory
              <span className="font-mono">
                <span className={pc.freeCores > 0 ? "text-ok-fg" : "text-muted-foreground"}>
                  {nf(pc.freeCores)} {unit} {t("part.available")}
                </span>
                {pc.freeCores > 0 && <span className="text-muted-foreground"> {t("pool.scatteredNote")}</span>}
              </span>
            )}
            {isGpu && (pool?.gpu?.reserved ?? 0) > 0 && (
              <>
                <span>·</span>
                <span className="font-mono text-warn-fg">
                  {t("pool.reserved", { n: nf(pool?.gpu?.reserved ?? 0) })}
                </span>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function UnitBlocks({
  free,
  used,
  reserved,
  down,
  total,
  unit,
  schedulable,
}: {
  free: number;
  used: number;
  reserved: number;
  down: number;
  total: number;
  unit: string;
  /** GPU pools only: of `free`, how many at least one sibling policy could
   *  actually grant right now — splits the free segment green/yellow instead
   *  of counting every physically-idle GPU as equally available. */
  schedulable?: number;
}) {
  if (total <= 0) return null;
  const stranded = schedulable !== undefined ? Math.max(0, free - schedulable) : 0;
  const okFree = schedulable !== undefined ? Math.min(schedulable, free) : free;
  const [okCells, strandedCells, usedCells, reservedCells, downCells] = scaleCells(
    [okFree, stranded, used, reserved, down],
    total,
  );
  const cell = (n: number, cls: string, key: string) =>
    Array.from({ length: n }, (_, i) => (
      <span key={`${key}-${i}`} className={cn("h-2.5 min-w-0 flex-1 rounded-sm", cls)} />
    ));
  return (
    <div
      className="flex h-2.5 w-36 shrink-0 gap-px"
      title={`${nf(free)} ${unit} ${unit === "GPU" ? "free" : "available"}${stranded ? ` (${nf(stranded)} unused by any policy)` : ""} · ${nf(used)} used${reserved ? ` · ${nf(reserved)} reserved` : ""}${down ? ` · ${nf(down)} down` : ""}`}
    >
      {cell(okCells, "bg-ok", "ok")}
      {cell(strandedCells, "bg-warn", "stranded")}
      {cell(usedCells, "bg-bad", "used")}
      {cell(reservedCells, "bg-warn/70 ring-1 ring-inset ring-warn", "reserved")}
      {cell(downCells, "bg-bad/35 ring-1 ring-inset ring-bad/65", "down")}
    </div>
  );
}

function scaleCells(values: number[], total: number, maxCells = 48): number[] {
  const cells = Math.max(1, Math.min(maxCells, Math.round(total)));
  if (total <= maxCells) return values.map((v) => Math.max(0, Math.round(v)));
  const raw = values.map((v) => (Math.max(0, v) / total) * cells);
  const out = raw.map(Math.floor);
  let remaining = cells - out.reduce((sum, n) => sum + n, 0);
  raw
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac)
    .forEach(({ i }) => {
      if (remaining > 0) {
        out[i] += 1;
        remaining -= 1;
      }
    });
  return out;
}

function PartitionRow({
  p,
  isGpu,
  pc,
  cpuProbe,
  gpuSchedulable,
  gpuClear,
  gpuStranded,
  gpuAdvice,
  probeGeneratedAt,
  observedAt,
  probeMaxAge,
  policy,
  t,
}: {
  p: Partition;
  isGpu: boolean;
  pc: PoolCapacity;
  cpuProbe: CpuProbeRow | null;
  gpuSchedulable: number | null;
  gpuClear: boolean | null;
  gpuStranded: number;
  gpuAdvice: GpuPartitionAdvice | null;
  probeGeneratedAt: number;
  observedAt: number;
  probeMaxAge: number;
  policy?: PolicySnapshot;
  t: TFn;
}) {
  const maint = isMaintPartition(p);
  const labelPolicy = partitionLabelPolicy(p.name);
  const runtimePolicy = slurmPartitionPolicy(p.name, policy);
  const groupRunning = p.jobs.running;
  const limitRows = policyLimitRows(runtimePolicy, groupRunning, t);
  const groupLimitReached = Boolean(runtimePolicy.grpJobs && groupRunning >= runtimePolicy.grpJobs);
  const gpuTip = gpuAdvice?.gpuTip ?? null;
  const backfillTip = gpuAdvice?.backfillTip ?? null;
  const cap = partitionCap(p.name, policy);
  const probeState = cpuProbe
    ? cpuProbeState(cpuProbe.probe, probeGeneratedAt, observedAt, probeMaxAge)
    : null;
  const hero = requestableNow(
    p, cap, isGpu, pc, gpuSchedulable,
    probeState === "now" ? cpuProbe?.cores : undefined,
  );
  // gpuClear === false means every free GPU slot is claimed by queued jobs
  // (or the node is PLANNED) — "can allocate" would be a false promise.
  const canRun = !maint && !groupLimitReached && (probeState ? probeState === "now" : hero.n > 0 && gpuClear !== false);
  // The hero count is a naive snapshot of idle hardware in the pool — it has no idea about
  // QOS group limits, scheduling priority, or the fact that multi-node jobs can piece
  // together scattered cores. sbatch --test-only does. Whenever the probe's verdict
  // contradicts the naive count (negative verdict vs a positive count, OR positive verdict
  // vs a zero count), defer to the probe and let the status Tag speak.
  // GPU only: the hero count from bin-packing alone (schedulable via cores/
  // mem fit) understates what's on screen when nothing fits but the pool
  // still has idle cards — show that idle count instead of a bare "0", and
  // let color alone say whether the default request can actually have it.
  const gpuDisplayHero = isGpu && hero.n <= 0 && gpuStranded > 0 ? { ...hero, n: gpuStranded } : hero;
  const heroHasEstimate = Boolean(probeState === "queued" && cpuProbe?.probe?.start_time);
  const heroOverride =
    !maint && (probeState === "queued" || probeState === "failed")
      ? heroHasEstimate
        ? t("pool.cpuProbeStart", { time: clockOf(cpuProbe!.probe!.start_time) })
        : "—" // the status Tag on the right already says queued/failed — don't repeat it here
      : !maint && probeState === "now" && hero.n <= 0
        ? "—" // probe proved the default request starts even though no whole node is idle
        : null;
  // "Available" reads wrong next to a queued/failed verdict — and next to a zero —
  // swap to a fitting label, or drop it when the override/tag already speaks.
  const heroLabel = !heroOverride
    ? hero.n > 0
      ? t("part.requestNow")
      : null
    : heroHasEstimate
      ? t("col.startEst")
      : null;
  const showTestedCommand = Boolean(cpuProbe?.probe && !maint && (probeState === "now" || probeState === "queued"));

  return (
    <div className={maint ? "rounded-md border border-dashed border-border bg-muted/20 px-2 py-2" : "py-2"}>
      <div className="grid gap-x-3 gap-y-1 sm:grid-cols-[9rem_minmax(0,1fr)_auto] sm:items-center">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{p.name}</div>
          <div className="truncate text-xs text-muted-foreground">{t(labelPolicy.title)}</div>
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            {heroLabel && <span className="text-xs text-muted-foreground">{heroLabel}</span>}
            <span
              className={cn(
                "font-mono text-base font-semibold",
                canRun && heroOverride !== "—"
                  ? "text-ok-fg"
                  : isGpu && !maint && gpuDisplayHero.n > 0
                    ? "text-warn-fg"
                    : "text-muted-foreground",
              )}
            >
              {maint ? "—" : (heroOverride ?? heroText(t, gpuDisplayHero))}
              {!heroOverride && hero.capped && !maint && (
                <HoverHint text={t("part.capHint")} className="ml-0.5 align-super text-xs" />
              )}
            </span>
            <span className="font-mono text-xs text-muted-foreground">
              {t("part.policyLimit")} {fmtPolicyLimit(cap, isGpu, t, p.name) || "—"}
            </span>
            <span className={cn("font-mono text-xs", p.jobs.pending > 0 ? "text-warn-fg" : "text-muted-foreground")}>
              {t("part.run")}{nf(p.jobs.running)} {t("part.pend")}{nf(p.jobs.pending)}
            </span>
          </div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground/80">{t(labelPolicy.desc)}</div>
          {gpuTip && (
            <div className="mt-0.5 text-xs text-warn-fg">
              {t("pool.quickGpuMemHint", { mem: gpuTip.mem })} · {gpuTip.node}
            </div>
          )}
          {backfillTip && (
            <div className="mt-0.5 text-xs text-info-fg">
              {t("pool.quickGpuBfHint", { t: backfillTip.t })} · {backfillTip.node}
            </div>
          )}
          <PolicyLimitChips rows={limitRows} />
          {cpuProbe && !maint && (
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
              {showTestedCommand && (
                <span className="inline-flex max-w-full min-w-0 items-center gap-1 text-muted-foreground">
                  <span className="min-w-0 truncate font-mono text-foreground">{cpuProbe.command}</span>
                  <CopyButton text={cpuProbe.command} />
                </span>
              )}
              {cpuProbe.cores > 0 && (
                <span className="font-mono text-muted-foreground">
                  {t("pool.cpuProbeNeed", { cores: cpuProbe.cores })}
                </span>
              )}
              <span className="min-w-0 truncate text-muted-foreground">{cpuProbeDetail(cpuProbe, probeState, t)}</span>
            </div>
          )}
        </div>
        <div className="flex items-center sm:justify-end">
          {maint ? (
            <Tag tone="neutral">{t("pool.maint")}</Tag>
          ) : groupLimitReached ? (
            <Tag tone="warn">{t("part.willQueue")}</Tag>
          ) : probeState ? (
            <Tag tone={cpuProbeTone(probeState)}>{cpuProbeLabel(probeState, t)}</Tag>
          ) : gpuTip ? (
            <Tag tone="warn">{t("pool.optBypass")}</Tag>
          ) : backfillTip ? (
            <Tag tone="info">{t("pool.optGap")}</Tag>
          ) : canRun ? (
            <Tag tone="ok">{t("part.canAllocate")}</Tag>
          ) : (
            <Tag tone="warn">{t("part.willQueue")}</Tag>
          )}
        </div>
      </div>
    </div>
  );
}
