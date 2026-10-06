import { Fragment } from "react";
import { CopyButton } from "@/components/common/copy-button";
import { Empty } from "@/components/common/empty";
import { HoverHint } from "@/components/common/hover-hint";
import { dayClockLabel, GpuReleaseHint } from "@/components/common/gpu-release-hint";
import { SectionCard } from "@/components/common/section-card";
import { LivePending } from "@/components/common/live-pending";
import { PolicyLimitChips } from "@/components/common/policy-limit-chips";
import { Tag } from "@/components/common/tag";
import { UnitBlocks } from "@/components/common/unit-blocks";
import { gpuSegmentLabel } from "@/components/common/gpu-status";
import { gpuVerdictTag } from "@/components/common/verdict-text";
import { useLive } from "@/hooks/live-context";
import { useResourceFilter } from "@/hooks/resource-filter-context";
import { coresText, poolTitle, useT, type TFn } from "@/i18n";
import type { TranslationKey } from "@/i18n/en";
import { cpuPartitionStatus, cpuPartitionTone, cpuPartitionVerdict, type CpuPartitionStatus } from "@/lib/cpu-partition";
import { poolCapacity, poolNodeStates, type PoolCapacity, type PoolNodeStates } from "@/lib/derive";
import { fmtMB, nf } from "@/lib/format";
import type { GpuAvailability } from "@/lib/gpu-availability";
import { partitionGpuAvailability, poolGpuAvailability } from "@/lib/gpu-fit";
import { gpuShapeOf, gpuStartCount, gpuStatus, gpuVerdict, type GpuStatus } from "@/lib/gpu-partition";
import { cpuProbeDetail, fmtPolicyLimit, policyLimitRows } from "@/lib/policy-hints";
import { partitionsOf, queueModel } from "@/lib/queue";
import {
  isLicensePartition,
  matchPartition,
  partitionCap,
  partitionDisplayRank,
  partitionDown,
  partitionPolicy,
  type Tone,
} from "@/lib/slurm";
import { cn } from "@/lib/utils";
import type { Partition, Pool, Snapshot } from "@/types/snapshot";

/** A partition's title and description from the site's text
 *  (`policy.<name>` / `policy.<name>.desc`), else the generic pair. */
function partitionLabelPolicy(name: string, t: TFn): { title: TranslationKey; desc: TranslationKey } {
  const title = `policy.${name}` as TranslationKey;
  const desc = `policy.${name}.desc` as TranslationKey;
  return {
    title: t(title) !== title ? title : "policy.other",
    desc: t(desc) !== desc ? desc : "policy.other.desc",
  };
}

/** One partition row, judged once: the same verdict functions the Overview's
 *  quick request reads (lib/gpu-partition, lib/cpu-partition). */
interface Row {
  p: Partition;
  maint: boolean;
  gpu: GpuStatus | null;
  cpu: CpuPartitionStatus | null;
  tag: { tone: Tone; label: string };
  /** 0 starts now, 1 starts with a tip, 2 queues, 3 no data, 4 refused or in maintenance */
  rank: number;
  /** GPUs one job starts with now (GPU rows) */
  gpusNow: number;
  /** idle GPUs this partition's default request cannot take now */
  gpusStranded: number;
}

function rowOf(snap: Snapshot, pool: Pool | undefined, p: Partition, t: TFn): Row {
  const maint = partitionDown(p);
  if (p.kind === "gpu" && pool) {
    const gpu = gpuStatus(snap, pool, p.name);
    const verdict = gpuVerdict(gpu);
    const stranded = partitionGpuAvailability(snap, pool, p.name).segments
      .filter((seg) => seg.kind !== "ready" && seg.kind !== "down" && seg.kind !== "full")
      .reduce((sum, seg) => sum + seg.count, 0);
    return {
      p, maint, gpu, cpu: null, tag: gpuVerdictTag(gpu, t),
      rank: verdict === "now" ? 0 : verdict === "bypass" || verdict === "gap" ? 1 : verdict === "queue" ? 2 : 4,
      gpusNow: gpuStartCount(snap, pool, p.name), gpusStranded: stranded,
    };
  }
  const cpu = cpuPartitionStatus(snap, p.name);
  const tone = cpuPartitionTone(cpu);
  return {
    p, maint, gpu: null, cpu,
    tag: maint ? { tone: "neutral", label: t("pool.maint") } : cpuPartitionVerdict(cpu, t),
    rank: maint ? 4 : tone === "ok" ? 0 : tone === "warn" ? 2 : tone === "bad" ? 4 : 3,
    gpusNow: 0, gpusStranded: 0,
  };
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

  // Group by hardware pool; app-specific partitions remain under the same pool.
  const byPool = new Map<string, Partition[]>();
  for (const p of snap.partitions.filter((part) => matchPartition(part, filter))) {
    const key = p.pool ?? "other";
    byPool.set(key, [...(byPool.get(key) ?? []), p]);
  }
  const order = snap.pools.map((p) => p.id);
  const poolById = new Map(snap.pools.map((p) => [p.id, p]));
  const groups = [...byPool.entries()].sort(([a], [b]) =>
    Number(!!poolById.get(a)?.gpu?.maint) - Number(!!poolById.get(b)?.gpu?.maint) || order.indexOf(a) - order.indexOf(b));
  // a job queued to several partitions ("-p DEF,SMALL,SINGLE") waits in each
  // of them but starts in one: count those per partition, once
  const pendShared = new Map<string, number>();
  for (const { job } of queueModel(snap).waiters) {
    const parts = partitionsOf(job);
    if (parts.length > 1) for (const p of parts) pendShared.set(p, (pendShared.get(p) ?? 0) + 1);
  }

  return (
    <SectionCard bodyClassName="pt-4">
      {groups.length === 0 ? (
        <Empty>—</Empty>
      ) : (
        <div className="space-y-5">
          {groups.map(([poolKey, parts]) => {
            const pool = poolById.get(poolKey);
            const isGpu = parts[0].kind === "gpu";
            // startable first, then the site's own order — never the load,
            // which reshuffled the rows with every sample
            const rows = parts.map((p) => rowOf(snap, pool, p, t)).sort((a, b) =>
              a.rank - b.rank || partitionDisplayRank(a.p.name) - partitionDisplayRank(b.p.name));
            const general = rows.filter((r) => !isLicensePartition(r.p.name, snap.policy));
            const materials = rows.filter((r) => isLicensePartition(r.p.name, snap.policy));
            return (
              <div key={poolKey}>
                <PoolHeader
                  pool={pool}
                  label={poolTitle(t, pool, poolKey)}
                  spec={parts[0].spec}
                  isGpu={isGpu}
                  pc={poolCapacity(snap, poolKey)}
                  gpuAvail={isGpu && pool ? poolGpuAvailability(snap, pool) : null}
                  nodeStates={poolNodeStates(snap, poolKey)}
                  generatedAt={snap.generated_at}
                  t={t}
                />
                {parts.length > 1 && <p className="mb-1.5 text-xs text-muted-foreground/80">{t("part.shared")}</p>}
                <div className="space-y-2">
                  {general.length > 0 && (
                    <PartitionRows
                      label={materials.length > 0 ? t("part.generalCpuPolicies") : ""}
                      rows={general}
                      pool={pool}
                      snap={snap}
                      pendShared={pendShared}
                      t={t}
                    />
                  )}
                  {materials.length > 0 && (
                    <PartitionRows
                      label={t("part.materialsStudioGroup")}
                      note={t("part.materialsStudioNote")}
                      rows={materials}
                      pool={pool}
                      snap={snap}
                      pendShared={pendShared}
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

function PartitionRows({ label, note, rows, pool, snap, pendShared, t }: {
  label: string;
  note?: string;
  rows: Row[];
  pool?: Pool;
  snap: Snapshot;
  pendShared: Map<string, number>;
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
        {rows.map((row) => (
          <PartitionRow key={row.p.name} row={row} pool={pool} snap={snap} pendShared={pendShared.get(row.p.name) ?? 0} t={t} />
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
  gpuAvail,
  nodeStates,
  generatedAt,
  t,
}: {
  pool?: Pool;
  label: string;
  spec: Partition["spec"];
  isGpu: boolean;
  pc: PoolCapacity;
  gpuAvail?: GpuAvailability | null;
  /** Nodes the scheduler holds (PLANNED/RESERVED), from the raw node list. */
  nodeStates: PoolNodeStates;
  generatedAt: number;
  t: TFn;
}) {
  const maint = isGpu && !!pool?.gpu?.maint;
  const gpuReady = gpuAvail?.ready ?? 0;
  // Every idle-but-not-takeable state, in the classifier's own order.
  const gpuBlocked = (gpuAvail?.segments ?? []).filter((s) => s.kind !== "ready" && s.kind !== "full");
  // every number is self-labelled: which dimension is "used", and used/total in raw units.
  const used = isGpu ? pool?.gpu?.used ?? 0 : pool?.cores.alloc ?? 0;
  const total = isGpu ? pool?.gpu?.total ?? 0 : pool?.cores.total ?? 0;
  const util = total ? used / total : 0;
  const unit = isGpu ? t("unit.gpu") : t("unit.cores");
  const dim = isGpu ? t("dim.gpu") : t("dim.cpu");
  // one cell per node, by the shared rule (poolNodeStates) the pool card draws too
  const ns = nodeStates;
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
        free: ns.idle + ns.partial,
        used: ns.full,
        reserved: ns.held,
        down: ns.down,
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
            {coresText(t, spec.cores_per_node)} · {fmtMB(spec.mem_per_node)}
          </span>
        </div>
        {isGpu && <GpuReleaseHint next={pool?.gpu?.next_free} generatedAt={generatedAt} />}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        {/* CPU: only wholly idle nodes are green; a node with a few spare
            cores is amber — green for "8 of 256 cores free" overstated it. */}
        <UnitBlocks
          {...blocks}
          schedulable={isGpu ? gpuReady : ns.idle}
          strandedLabel={isGpu ? undefined : t("blocks.partlyFree")}
        />
        {maint ? (
          <>
            <Tag tone="neutral">{t("pool.maint")}</Tag>
            <span>{t("pool.offline", { n: nf(pool?.gpu?.down ?? total) })}</span>
          </>
        ) : (
          <>
            {/* the CPU bar counts nodes (one cell each) while the text after it
                counts cores — name the nodes in the bar's own colours */}
            {!isGpu && (
              <>
                <span className="font-mono">
                  {t("part.nodesPrefix")}{" "}
                  {([
                    ["part.nodesIdle", ns.idle, "text-ok-fg"],
                    ["part.nodesPartial", ns.partial, "text-warn-fg"],
                    ["part.nodesHeld", ns.held, "text-warn-fg"],
                    ["part.nodesFull", ns.full, "text-bad-fg"],
                    ["part.nodesDown", ns.down, "text-muted-foreground"],
                  ] as const)
                    .filter(([, n]) => n > 0)
                    .map(([key, n, cls], i) => (
                      <Fragment key={key}>
                        {i > 0 && " · "}
                        <span className={cls}>{t(key, { n: nf(n) })}</span>
                      </Fragment>
                    ))}
                </span>
                <span>·</span>
              </>
            )}
            <span className="font-mono">
              {dim} {Math.round(util * 100)}% {t("kpi.used")} ({nf(used)}/{nf(total)} {unit})
            </span>
            <span>·</span>
            {isGpu ? (
              // "available" means takeable now, exactly as on the pool cards —
              // a green zero would contradict the colour language, so grey it out
              <span className={cn("font-mono", gpuReady > 0 ? "text-ok-fg" : "text-muted-foreground")}>
                {nf(gpuReady)} {unit} {t("part.available")}
              </span>
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
            {isGpu && gpuBlocked.map((segment) => (
              <Fragment key={segment.kind}>
                <span>·</span>
                <span className={cn("font-mono", segment.kind === "down" ? "text-muted-foreground" : "text-warn-fg")}>
                  {nf(segment.count)} {unit} {gpuSegmentLabel(segment.kind, t)}
                </span>
              </Fragment>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function PartitionRow({ row, pool, snap, pendShared, t }: {
  row: Row;
  pool?: Pool;
  snap: Snapshot;
  pendShared: number;
  t: TFn;
}) {
  const { p, maint, gpu, cpu, tag } = row;
  const isGpu = p.kind === "gpu";
  const policy = snap.policy;
  const labelPolicy = partitionLabelPolicy(p.name, t);
  const limitRows = policyLimitRows(partitionPolicy(p.name, policy), queueModel(snap).running(p.name), t);
  const cap = partitionCap(p.name, policy);
  const starts = tag.tone === "ok";
  const verdict = gpu ? gpuVerdict(gpu) : null;
  // the hero number: what one job gets now — GPUs a job starts with, or the
  // cores the CPU status counts. A GPU row with nothing to start but idle
  // cards shows those in amber rather than a bare "0".
  const probeState = cpu?.state ?? null;
  const estimate = cpu?.estimate ?? null;
  const cpuOverride = !maint && (probeState === "queued" || probeState === "failed")
    ? estimate ? t("pool.cpuProbeStart", { time: dayClockLabel(estimate, t) }) : "—"
    : null;
  const gpuShown = row.gpusNow > 0 ? row.gpusNow : row.gpusStranded;
  const heroText = maint ? "—" : cpuOverride ?? (isGpu ? `${nf(gpuShown)} ${t("unit.gpu")}` : coresText(t, cpu?.maxCores ?? 0));
  const heroCount = isGpu ? row.gpusNow : cpu?.maxCores ?? 0;
  const heroLabel = cpuOverride
    ? estimate ? t("col.startEst") : null
    : heroCount > 0 && starts ? t("verdict.now") : null;
  const heroTone = starts && cpuOverride !== "—"
    ? "text-ok-fg"
    : isGpu && !maint && gpuShown > 0
      ? "text-warn-fg"
      : "text-muted-foreground";
  // one node's free cores under the policy cap: the hint says so with the
  // numbers (not when the count is the probe's default request)
  const capped = Boolean(cpu && !maint && !cpuOverride && !cpu.spread && !cpu.fromProbe && cap.maxCores !== undefined
    && cpu.maxCores > 0 && cpu.maxCores < cap.maxCores);
  // the command the verdict is about (with the corrected -L where the plugin's
  // license name doesn't exist); none for a row that needs a -L of your own
  const showCommand = Boolean(cpu && !maint && (probeState === "now" || probeState === "queued")
    && cpu.license.kind !== "required" && cpu.license.kind !== "missing");
  const probeDetail = cpu?.probe ? cpuProbeDetail(cpu.probe, probeState, t) : "";

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
            <span className={cn("font-mono text-base font-semibold", heroTone)}>
              {heroText}
              {capped && cpu && (
                <HoverHint text={t("part.capHint", { n: nf(cpu.maxCores), max: nf(cap.maxCores ?? 0) })} className="ml-0.5 align-super text-xs" />
              )}
            </span>
            <span className="font-mono text-xs text-muted-foreground">
              {t("part.policyLimit")} {fmtPolicyLimit(cap, isGpu, t, p.name, p.spec.mem_per_node, policy,
                isGpu && pool && p.spec.gpu_per_node > 0 ? gpuShapeOf(p, pool) : undefined, p.spec.cores_per_node) || "—"}
            </span>
            <span className={cn("font-mono text-xs", p.jobs.pending > 0 ? "text-warn-fg" : "text-muted-foreground")}>
              {t("part.run")}{nf(p.jobs.running)} {t("part.pend")}{nf(p.jobs.pending)}
              {pendShared > 0 && (
                <HoverHint text={t("part.pendShared", { n: pendShared })} className="ml-0.5 align-super text-xs" />
              )}
            </span>
          </div>
          {t(labelPolicy.desc) && (
            <div className="mt-0.5 text-xs text-muted-foreground/80">
              {t(labelPolicy.desc)}
            </div>
          )}
          {verdict === "bypass" && gpu?.memTip && (
            <div className="mt-0.5 text-xs text-warn-fg">
              {t("pool.quickGpuMemHint", { mem: gpu.memTip.mem })} · {gpu.memTip.node}
            </div>
          )}
          {verdict === "gap" && gpu?.gapTip && (
            <div className="mt-0.5 text-xs text-info-fg">
              {t("pool.quickGpuBfHint", { t: gpu.gapTip.t })} · {gpu.gapTip.node}
            </div>
          )}
          <PolicyLimitChips rows={limitRows} />
          {cpu?.license.kind === "fixed" && !maint && (
            <div className="mt-0.5 text-xs text-warn-fg">
              {t("pool.licenseFixed", { bad: cpu.license.pluginDefault ?? "", good: cpu.license.name ?? "" })}
            </div>
          )}
          {cpu && !maint && (showCommand || cpu.probe) && (
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
              {showCommand && (
                <span className="inline-flex max-w-full min-w-0 items-center gap-1 text-muted-foreground">
                  <span className="min-w-0 truncate font-mono text-foreground">{cpu.command}</span>
                  <CopyButton text={cpu.command} />
                </span>
              )}
              {cpu.probe && cpu.probe.cores > 0 && (
                <span className="font-mono text-muted-foreground">
                  {t("pool.cpuProbeNeed", { cores: cpu.probe.cores })}
                </span>
              )}
              {probeDetail && <span className="min-w-0 truncate text-muted-foreground">{probeDetail}</span>}
            </div>
          )}
        </div>
        <div className="flex items-center sm:justify-end">
          <Tag tone={tag.tone}>{tag.label}</Tag>
        </div>
      </div>
    </div>
  );
}
