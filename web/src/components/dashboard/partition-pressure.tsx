import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Empty } from "@/components/common/empty";
import { HoverHint } from "@/components/common/hover-hint";
import { SectionCard } from "@/components/common/section-card";
import { Tag } from "@/components/common/tag";
import { useLive } from "@/hooks/use-live";
import { useResourceFilter } from "@/hooks/use-resource-filter";
import { poolLabel, useT, type TFn } from "@/i18n";
import type { TranslationKey } from "@/i18n/en";
import { copyText } from "@/lib/clipboard";
import { poolCapacity, type PoolCapacity } from "@/lib/derive";
import { clockOf, fmtMB, nf } from "@/lib/format";
import { cleanCpuProbeRaw, cpuProbeForPartition, cpuProbeState, type CpuProbeRow, type CpuProbeState } from "@/lib/cpu-probes";
import {
  isMaterialsStudioPartition,
  matchPartition,
  partitionCap,
  partitionPolicy as slurmPartitionPolicy,
  type PartitionCap,
  type PartitionPolicy,
} from "@/lib/slurm";
import { cn } from "@/lib/utils";
import type { Partition, PolicySnapshot, Pool } from "@/types/snapshot";

const PARTITION_POLICIES: Record<string, { title: TranslationKey; desc: TranslationKey }> = {
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
  return PARTITION_POLICIES[name] ?? { title: "policy.other", desc: "policy.other.desc" };
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

function requestableNow(p: Partition, cap: PartitionCap, isGpu: boolean, pc: PoolCapacity): Hero {
  if (isGpu) {
    const free = p.gpu?.free ?? 0;
    return { n: Math.min(cap.maxGpus ?? free, free), unit: "gpu", capped: false };
  }
  if ((cap.maxNodes ?? 1) > 1) {
    return { n: pc.idleNodes, unit: "nodes", capped: false };
  }
  const limit = cap.maxCores ?? pc.emptiestNodeFree;
  const n = Math.min(limit, pc.emptiestNodeFree);
  return { n, unit: "cores", capped: cap.maxCores !== undefined && n < cap.maxCores };
}

function heroText(t: TFn, h: Hero): string {
  if (h.unit === "gpu") return `${nf(h.n)} ${t("unit.gpu")}`;
  if (h.unit === "nodes") return `${nf(h.n)} ${t("part.wholeNodes")}`;
  return `${nf(h.n)}c`;
}

function fmtCapMem(gb?: number) {
  if (!gb) return "";
  if (gb >= 1024) {
    const tb = gb / 1024;
    return `${Number.isInteger(tb) ? tb : tb.toFixed(1)}TB`;
  }
  return `${gb}GB`;
}

function fmtPolicyLimit(cap: PartitionCap, isGpu: boolean, nodesLabel: string) {
  const parts: string[] = [];
  if (isGpu && cap.maxGpus) parts.push(`${cap.maxGpus} GPU`);
  if (cap.maxCores) parts.push(`${nf(cap.maxCores)}c`);
  if (cap.maxMemGb) parts.push(fmtCapMem(cap.maxMemGb));
  if (cap.maxNodes) parts.push(`${nf(cap.maxNodes)} ${nodesLabel}`);
  if (cap.wall) parts.push(cap.wall);
  return parts.join(" / ") || "—";
}

export function PartitionPressure() {
  const { snap } = useLive();
  const { filter } = useResourceFilter();
  const t = useT();
  if (!snap) return null;

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
    <SectionCard title={t("section.partitions")} extra={`${matched.length} · ${t("part.requestNow")}`}>
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
              const state = cpuProbeState(row.probe, snap.cpu_submit_probes_generated_at || snap.generated_at);
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
            return (
              <div key={group.key}>
                <PoolHeader pool={pool} label={poolLabel(t, group.poolKey)} spec={spec} isGpu={isGpu} pc={pc} t={t} />
                {parts.length > 1 && <p className="mb-1.5 text-[11px] text-muted-foreground/80">{t("part.shared")}</p>}
                <div className="space-y-2">
                  {generalParts.length > 0 && (
                    <PartitionRows
                      label={materialsParts.length > 0 ? t("part.generalCpuPolicies") : ""}
                      parts={generalParts}
                      isGpu={isGpu}
                      pc={pc}
                      cpuProbeFor={(p) => (!isGpu ? cpuProbeForPartition(snap, p.name) : null)}
                      generatedAt={snap.cpu_submit_probes_generated_at || snap.generated_at}
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
                      generatedAt={snap.cpu_submit_probes_generated_at || snap.generated_at}
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
  generatedAt,
  policy,
  t,
}: {
  label: string;
  note?: string;
  parts: Partition[];
  isGpu: boolean;
  pc: PoolCapacity;
  cpuProbeFor: (p: Partition) => CpuProbeRow | null;
  generatedAt: number;
  policy?: PolicySnapshot;
  t: TFn;
}) {
  return (
    <div>
      {label && (
        <div className="mb-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11px]">
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
            generatedAt={generatedAt}
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
  t,
}: {
  pool?: Pool;
  label: string;
  spec: Partition["spec"];
  isGpu: boolean;
  pc: PoolCapacity;
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
        down: pool?.gpu?.down ?? 0,
        total: pool?.gpu?.total ?? 0,
        unit: t("unit.gpu"),
      }
    : {
        free: availableNodeCount,
        used: busyNodes,
        down: downNodes,
        total: pool?.nodes ?? 0,
        unit: t("spec.nodes"),
      };
  return (
    <div className="mb-1.5 border-b border-border pb-1.5">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-sm font-semibold">{label}</span>
        <span className="font-mono text-[11px] text-muted-foreground">
          {nf(pool?.nodes ?? 0)} {t("spec.nodes")} · {t("spec.perNode")}{" "}
          {spec.gpu_per_node > 0 && `${spec.gpu_per_node} GPU · `}
          {spec.cores_per_node}c · {fmtMB(spec.mem_per_node)}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
        <UnitBlocks {...blocks} />
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
          </>
        )}
      </div>
    </div>
  );
}

function UnitBlocks({
  free,
  used,
  down,
  total,
  unit,
}: {
  free: number;
  used: number;
  down: number;
  total: number;
  unit: string;
}) {
  if (total <= 0) return null;
  const [freeCells, usedCells, downCells] = scaleCells([free, used, down], total);
  const cell = (n: number, cls: string, key: string) =>
    Array.from({ length: n }, (_, i) => (
      <span key={`${key}-${i}`} className={cn("h-2.5 min-w-0 flex-1 rounded-sm", cls)} />
    ));
  return (
    <div
      className="flex h-2.5 w-36 shrink-0 gap-px"
      title={`${nf(free)} ${unit} ${unit === "GPU" ? "free" : "available"} · ${nf(used)} used${down ? ` · ${nf(down)} down` : ""}`}
    >
      {cell(freeCells, "bg-ok", "free")}
      {cell(usedCells, "bg-bad", "used")}
      {cell(downCells, "bg-muted-foreground/40", "down")}
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
  generatedAt,
  policy,
  t,
}: {
  p: Partition;
  isGpu: boolean;
  pc: PoolCapacity;
  cpuProbe: CpuProbeRow | null;
  generatedAt: number;
  policy?: PolicySnapshot;
  t: TFn;
}) {
  const [copied, setCopied] = useState(false);
  const maint = isMaintPartition(p);
  const labelPolicy = partitionLabelPolicy(p.name);
  const runtimePolicy = slurmPartitionPolicy(p.name, policy);
  const groupRunning = p.jobs.running;
  const limitRows = partitionPolicyLimitRows(runtimePolicy, groupRunning, t);
  const groupLimitReached = Boolean(runtimePolicy.grpJobs && groupRunning >= runtimePolicy.grpJobs);
  const cap = partitionCap(p.name, policy);
  const hero = requestableNow(p, cap, isGpu, pc);
  const probeState = cpuProbe ? cpuProbeState(cpuProbe.probe, generatedAt) : null;
  const canRun = !maint && !groupLimitReached && (probeState ? probeState === "now" : hero.n > 0);
  // The hero count is a naive snapshot of idle hardware in the pool — it has no idea about
  // QOS group limits or scheduling priority. sbatch --test-only does. When the probe gives a
  // definitive negative answer for this exact partition, defer to it instead of showing a node/
  // core count that would contradict the "will queue" badge right next to it.
  const heroHasEstimate = Boolean(probeState === "queued" && cpuProbe?.probe?.start_time);
  const heroOverride =
    !maint && (probeState === "queued" || probeState === "failed")
      ? heroHasEstimate
        ? t("pool.cpuProbeStart", { time: clockOf(cpuProbe!.probe!.start_time) })
        : partitionCpuProbeLabel(probeState, t)
      : null;
  // "Available" reads wrong next to a queued/failed verdict — swap to a fitting label,
  // or drop the label entirely when the override text already speaks for itself.
  const heroLabel = !heroOverride ? t("part.requestNow") : heroHasEstimate ? t("col.startEst") : null;
  const showTestedCommand = Boolean(cpuProbe?.probe && !maint && (probeState === "now" || probeState === "queued"));
  const copyCommand = async () => {
    if (!cpuProbe || !showTestedCommand) return;
    if (await copyText(cpuProbe.command)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }
  };

  return (
    <div className={maint ? "py-2 opacity-55" : "py-2"}>
      <div className="grid gap-x-3 gap-y-1 sm:grid-cols-[9rem_minmax(0,1fr)_auto] sm:items-center">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{p.name}</div>
          <div className="truncate text-[11px] text-muted-foreground">{t(labelPolicy.title)}</div>
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            {heroLabel && <span className="text-[11px] text-muted-foreground">{heroLabel}</span>}
            <span className={cn("font-mono text-base font-semibold", canRun ? "text-ok-fg" : "text-muted-foreground")}>
              {maint ? "—" : (heroOverride ?? heroText(t, hero))}
              {!heroOverride && hero.capped && !maint && (
                <HoverHint text={t("part.capHint")} className="ml-0.5 align-super text-[10px]" />
              )}
            </span>
            <span className="font-mono text-[11px] text-muted-foreground">
              {t("part.policyLimit")} {fmtPolicyLimit(cap, isGpu, t("spec.nodes"))}
            </span>
            <span className={cn("font-mono text-[11px]", p.jobs.pending > 0 ? "text-warn-fg" : "text-muted-foreground")}>
              {t("part.run")}{nf(p.jobs.running)} {t("part.pend")}{nf(p.jobs.pending)}
            </span>
          </div>
          <div className="mt-0.5 truncate text-[11px] text-muted-foreground/80">{t(labelPolicy.desc)}</div>
          {limitRows.length > 0 && <PartitionPolicyLimits rows={limitRows} />}
          {cpuProbe && !maint && (
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px]">
              {showTestedCommand && (
                <span className="inline-flex max-w-full min-w-0 items-center gap-1 text-muted-foreground">
                  <span className="min-w-0 truncate font-mono text-foreground">{cpuProbe.command}</span>
                  <button
                    type="button"
                    onClick={copyCommand}
                    title={t(copied ? "helper.copied" : "helper.copy")}
                    aria-label={t(copied ? "helper.copied" : "helper.copy")}
                    className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  </button>
                </span>
              )}
              <span className="font-mono text-muted-foreground">
                {t("pool.cpuProbeNeed", { cores: cpuProbe.cores })}
              </span>
              <span className="min-w-0 truncate text-muted-foreground">{partitionCpuProbeDetail(cpuProbe, probeState, t)}</span>
            </div>
          )}
        </div>
        <div className="flex items-center sm:justify-end">
          {maint ? (
            <Tag tone="neutral">{t("pool.maint")}</Tag>
          ) : groupLimitReached ? (
            <Tag tone="warn">{t("part.willQueue")}</Tag>
          ) : probeState ? (
            <Tag tone={partitionCpuProbeTone(probeState)}>{partitionCpuProbeLabel(probeState, t)}</Tag>
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

function PartitionPolicyLimits({
  rows,
}: {
  rows: Array<{ key: string; label: string; reached: boolean; near: boolean }>;
}) {
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {rows.map((row) => (
        <span
          key={row.key}
          className={cn(
            "rounded-md border px-1.5 py-0.5 text-[10px]",
            row.reached
              ? "border-bad/30 bg-bad-soft text-bad-fg"
              : row.near
                ? "border-warn/30 bg-warn-soft text-warn-fg"
                : "border-border bg-muted/40 text-muted-foreground",
          )}
        >
          {row.label}
        </span>
      ))}
    </div>
  );
}

function partitionPolicyLimitRows(policy: PartitionPolicy, groupRunning: number, t: TFn) {
  const rows: Array<{ key: string; label: string; reached: boolean; near: boolean }> = [];
  if (policy.grpJobs) {
    rows.push({
      key: "grp",
      label: t("pool.limitGroup", { n: groupRunning, max: policy.grpJobs }),
      ...limitLevel(groupRunning, policy.grpJobs),
    });
  }
  if (policy.maxJobsPerUser && policy.maxSubmitPerUser) {
    rows.push({
      key: "user",
      label: t("pool.limitUserBoth", { running: policy.maxJobsPerUser, submitted: policy.maxSubmitPerUser }),
      reached: false,
      near: false,
    });
  } else if (policy.maxJobsPerUser) {
    rows.push({
      key: "userRun",
      label: t("pool.limitUserRunning", { max: policy.maxJobsPerUser }),
      reached: false,
      near: false,
    });
  } else if (policy.maxSubmitPerUser) {
    rows.push({
      key: "userSubmit",
      label: t("pool.limitUserSubmitted", { max: policy.maxSubmitPerUser }),
      reached: false,
      near: false,
    });
  }
  return rows;
}

function limitLevel(current: number, max: number) {
  return {
    reached: current >= max,
    near: max > 1 && current >= Math.ceil(max * 0.8),
  };
}

function partitionCpuProbeLabel(state: CpuProbeState, t: TFn) {
  if (state === "now") return t("pool.cpuProbeNow");
  if (state === "queued") return t("pool.cpuProbeQueued");
  if (state === "unknown") return t("pool.cpuProbeNoData");
  return t("pool.cpuProbeFailed");
}

function partitionCpuProbeTone(state: CpuProbeState) {
  if (state === "now") return "ok" as const;
  if (state === "queued") return "warn" as const;
  if (state === "unknown") return "neutral" as const;
  return "bad" as const;
}

function partitionCpuProbeDetail(row: CpuProbeRow, state: CpuProbeState | null, t: TFn) {
  if (!row.probe) return t("pool.cpuProbeNoData");
  if (state === "now") return row.probe.nodes ? t("pool.cpuProbeNodes", { nodes: row.probe.nodes }) : "";
  if (state === "queued" && row.probe.start_time) return t("pool.cpuProbeStart", { time: clockOf(row.probe.start_time) });
  const raw = cleanCpuProbeRaw(row.probe.raw);
  return raw.length > 120 ? `${raw.slice(0, 117)}...` : raw;
}
