import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { ChevronRight, ExternalLink, Link2, Link2Off } from "lucide-react";
import { CopyButton } from "@/components/common/copy-button";
import { OccupancyMap, type OccupancyTile } from "@/components/common/occupancy-map";
import { dayClockLabel, GpuReleaseHint } from "@/components/common/gpu-release-hint";
import { FieldLabel, FieldNote, RangeSlider, SliderValueFixed, SliderValueInput, type SliderTick } from "@/components/common/range-slider";
import { Segmented } from "@/components/common/segmented";
import { Tag } from "@/components/common/tag";
import { UnitBlocks } from "@/components/common/unit-blocks";
import { barCells } from "@/lib/unit-cells";
import { Card, CardContent } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { PartitionTable, type PartitionAxis, type PartitionTableRow } from "@/components/dashboard/partition-table";
import { useLive } from "@/hooks/live-context";
import { useResourceFilter } from "@/hooks/resource-filter-context";
import { coresText, durText, poolTitle, reasonLabel, useT, wallText, type TFn, type TranslationKey } from "@/i18n";
import { nextUpOrder } from "@/lib/pending-order";
import { occupancyMode } from "@/lib/occupancy-mode";
import { nodeIsSchedulable, occupantsForPool, poolCapacity, unschedulableCores } from "@/lib/derive";
import { fmtCountdown, fmtDur, fmtMB, nf, parseDur } from "@/lib/format";
import type { GpuAvailabilitySegment } from "@/lib/gpu-availability";
import { gpuSegmentLabel, gpuSegmentTextClass } from "@/components/common/gpu-status";
import {
  cpuProbeDetail,
  cpuProbeLabel,
  cpuProbeTone,
  policyLimitRows,
} from "@/lib/policy-hints";
import {
  contendersForPool,
  fitHasClearSlot,
  gpuBackfillTipCommand,
  gpuFitSnapshot,
  gpuFitTipCommand,
  gpuFitWithMemOverride,
  isLimitBlocked,
  parseGpuCount,
  parseWalltimeSec,
  pendingForPool,
  poolGpuAvailability,
  slotBlocked,
  slotContention,
  withinBackfillWindow,
  type GpuBackfillTipData,
  type GpuFitInfo,
  type GpuFitNeed,
  type GpuFitNode,
  type GpuFitTipData,
} from "@/lib/gpu-fit";
import { allowsMultiNode, wallLabelSec, defaultRequestSec, interactiveForcedLabel, interactiveForcedSec, isLicensePartition, matchPool, minutesToSlurmTime, partitionCap, partitionDefaultRequest, partitionDefaults, partitionPolicy, type PartitionPolicy, type Tone } from "@/lib/slurm";
import { cn } from "@/lib/utils";
import { cpuDefaultSpreads, cpuProbeRows, cpuStartLimits, cpuStartMemMb, liveCpuStart, type CpuProbeRow } from "@/lib/cpu-probes";
import { buildRequestCommand, shouldShowGapShell } from "@/lib/request-command";
import { gpuLayouts, type GpuLayout, type GpuNodeShape } from "@/lib/gpu-layout";
import { requestLimits, type PoolShape } from "@/lib/request-limits";
import { licenseBusy, licensePlan } from "@/lib/licenses";
import { defaultRequestFit, singleNodeCoreFlag } from "@/lib/default-request";
import { gpuPartitionAdvice, partitionRunningJobs } from "@/lib/gpu-advice";
import { getSite } from "@/lib/site";
import type { Occupant, Partition, Pool, PoolGpu, RawJob, Snapshot } from "@/types/snapshot";


export function ResourcePools() {
  const { snap } = useLive();
  const { filter } = useResourceFilter();
  const t = useT();
  if (!snap) return null;
  const pools = snap.pools
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => matchPool(p, filter))
    .sort((a, b) => Number(!!a.p.gpu?.maint) - Number(!!b.p.gpu?.maint) || a.i - b.i)
    .map(({ p }) => p);
  const groups = [
    { key: "gpu", label: t("kpi.gpu"), pools: pools.filter((p) => p.kind === "gpu") },
    { key: "cpu", label: t("kpi.cpu"), pools: pools.filter((p) => p.kind === "cpu") },
  ].filter((g) => g.pools.length > 0);

  return (
    <div>
      <div className="space-y-5">
        {groups.map((g) => (
          <PoolGroup
            key={g.key}
            groupKey={g.key}
            label={g.label}
            pools={g.pools}
            snap={snap}
            t={t}
            outside={filter === "all" ? (snap.outside_nodes ?? []).filter((o) => (o.gpus > 0) === (g.key === "gpu")) : []}
          />
        ))}
      </div>
    </div>
  );
}

function PoolGroup({ groupKey, label, pools, snap, t, outside = [] }: {
  groupKey: string;
  label: string;
  pools: Pool[];
  snap: Snapshot;
  t: TFn;
  /** hardware of this kind no partition reaches: a gray card, not counted */
  outside?: NonNullable<Snapshot["outside_nodes"]>;
}) {
  const available = pools.filter((p) => hasAvailableNodes(p, snap)).length;
  const maint = pools.every(isMaintPool);
  // collapsed groups stay collapsed for this viewer
  const storeKey = `hm_pool_group_${groupKey}`;
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(storeKey) !== "closed";
    } catch {
      return true;
    }
  });
  const toggle = () => {
    setOpen(!open);
    try {
      localStorage.setItem(storeKey, open ? "closed" : "open");
    } catch {
      /* storage unavailable: the choice lasts this visit */
    }
  };
  return (
    <section className="space-y-2">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex w-full flex-wrap items-center gap-2 border-b border-border pb-1.5 text-left hover:text-foreground"
      >
        <ChevronRight className={cn("h-3.5 w-3.5 text-muted-foreground transition-transform", open && "rotate-90")} />
        <span className={cn("h-2.5 w-2.5 rounded-full", maint ? "bg-muted-foreground/45" : available > 0 ? "bg-ok" : "bg-bad")} />
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
        <span className="font-mono text-xs text-muted-foreground">
          {available}/{pools.length} {t("part.available")}
        </span>
      </button>
      {open && <div className={cn("grid gap-4", pools.length + outside.length > 1 && "lg:grid-cols-2")}>
        {pools.map((p) => (
          <PoolCard key={p.id} pool={p} snap={snap} t={t} />
        ))}
        {outside.map((o) => <OutsideCard key={o.pool} o={o} t={t} />)}
      </div>}
    </section>
  );
}

/** Hardware scontrol lists but no partition schedules: where it would sit,
 *  grayed, saying why it cannot be used from here. */
function OutsideCard({ o, t }: { o: NonNullable<Snapshot["outside_nodes"]>[number]; t: TFn }) {
  const outsideUrl = getSite().links.outside_hardware;
  return (
    <Card className="border-dashed bg-muted/30">
      <CardContent className="space-y-2 p-4">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="h-2.5 w-2.5 self-center rounded-full bg-muted-foreground/45" />
          <span className="font-semibold text-muted-foreground">{o.label || o.pool}</span>
          <span className="text-xs text-muted-foreground">
            {o.nodes} {t("spec.nodes")}{o.gpus ? ` · ${nf(o.gpus)} ${t("unit.gpu")}` : ""}
          </span>
        </div>
        <p className="text-sm text-muted-foreground">{t("pool.outsideCard")}</p>
        {outsideUrl && (
          <a
            href={outsideUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs text-info-fg hover:underline"
          >
            {t("pool.outsideLink")}
            <ExternalLink aria-hidden className="h-3 w-3" />
          </a>
        )}
      </CardContent>
    </Card>
  );
}

function PoolCard({ pool, snap, t }: { pool: Pool; snap: Snapshot; t: TFn }) {
  const [open, setOpen] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  const isGpu = pool.kind === "gpu";
  const maint = isMaintPool(pool);
  const availableNodes = pool.available_nodes ?? pool.idle_nodes ?? 0;
  const pendingActive = isGpu ? contendersForPool(snap, pool.id) : [];
  // One classifier decides every GPU number on this card — the same verdict
  // the filter chips, group header, KPIs and Partitions page read.
  const avail = isGpu ? poolGpuAvailability(snap, pool, Date.now(), pendingActive) : null;
  const readyGpu = avail?.ready ?? 0;
  // The header says "N GPUs free": idle GPUs on in-service nodes (= backend
  // gpu.free). Never physicalIdle — that also counts drained and
  // scheduler-held cards, which the body lists as their own segments.
  const freeGpu = avail?.free ?? 0;
  const hasAvailable = (isGpu ? readyGpu > 0 : availableNodes > 0) && !maint;
  // Idle but not directly takeable (queue-claimed, short, or held for a
  // backfill window) reads amber; only broken or busy hardware is red.
  const hasStrandedGpu = isGpu && !maint && readyGpu <= 0
    && (avail?.segments ?? []).some((s) => s.kind !== "ready" && s.kind !== "down" && s.kind !== "full");
  const availableNodesLabel = isGpu
    ? t("pool.gpuFreePhysical", { n: freeGpu })
    : t("pool.availableNodes", { n: availableNodes });
  const free = isGpu ? freeGpu : pool.cores.free;
  const total = isGpu && pool.gpu ? pool.gpu.total : pool.cores.total;
  const used = isGpu && pool.gpu ? pool.gpu.used : pool.cores.alloc;
  const cpuHeld = isGpu ? { reserved: 0, down: 0 } : unschedulableCores(snap.nodes, pool.id);
  // the same verdict as the dot beside the title: green when a job can start
  // now, amber when what is idle can't take the default request, red when
  // nothing is free. A share rule (<10% = amber) painted 75 free cores of
  // 31,744 amber on a card whose dot said a job starts now.
  const freeColor = maint
    ? "text-muted-foreground"
    : hasAvailable
      ? "text-ok-fg"
      : hasStrandedGpu || free > 0
        ? "text-warn-fg"
        : "text-bad-fg";

  return (
    <Card
      className={cn(
        // min-w-0: a grid item sizes to its longest unbreakable line without
        // it; the collapsed-row summary and the per-GPU block strip would
        // widen the card past a phone screen
        "min-w-0 transition-colors",
        maint
          ? "border-dashed border-muted-foreground/30 bg-muted/10"
          : hasAvailable
            ? "border-ok/40"
            : hasStrandedGpu
              ? "border-warn/40"
              : "border-bad/40",
      )}
    >
      <CardContent className="p-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "h-2.5 w-2.5 rounded-full ring-2",
                maint
                  ? "bg-muted-foreground/45 ring-muted-foreground/10"
                  : hasAvailable
                    ? "bg-ok ring-ok/20"
                    : hasStrandedGpu
                      ? "bg-warn ring-warn/20"
                      : "bg-bad ring-bad/20",
              )}
            />
            <span className="font-semibold">{poolTitle(t, pool)}</span>
            {/* GPU pools carry more cards than nodes (A100: 10 nodes x 2), and
                every big number on this card counts GPUs — state the pool's GPU
                total here so "20" never reads as a node count. */}
            <span className="text-xs text-muted-foreground">
              {pool.nodes} {t("spec.nodes")}
              {isGpu && pool.gpu ? ` · ${nf(pool.gpu.total)} ${t("unit.gpu")}` : ""}
              {" · "}
              {/* node memory, worded apart from the cards' own */}
              {t("pool.headMem", { mem: fmtMB(pool.mem_per_node) })}
            </span>
          </div>
          <span className="tnum font-mono text-sm text-muted-foreground">
            {maint ? t("pool.maint") : availableNodesLabel}
          </span>
        </div>

        <div className="mt-3 flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            {maint ? (
              <span className="text-lg font-semibold text-muted-foreground">{t("pool.maint")}</span>
            ) : isGpu && avail ? (
              <GpuAvailabilityBreakdown segments={avail.segments} t={t} />
            ) : (
              <>
                <div className="flex flex-wrap items-baseline gap-x-3">
                  <div className={cn("tnum text-2xl font-bold", freeColor)}>
                    {nf(free)}
                    <span className="text-sm font-normal text-muted-foreground">
                      {" / "}
                      {nf(total)} {t("unit.cores")}
                    </span>
                  </div>
                  {/* held cores are idle and may turn free at the next scheduling
                      pass — say so, or the free count seems to jump at random */}
                  {cpuHeld.reserved > 0 && (
                    <span className="text-xs text-warn-fg">{t("pool.coresReserved", { n: nf(cpuHeld.reserved) })}</span>
                  )}
                </div>
                <div className="text-xs text-muted-foreground">{availableNodesLabel}</div>
              </>
            )}
          </div>
          <GpuReleaseHint next={isGpu ? pool.gpu?.next_free : null} generatedAt={snap.generated_at} />
        </div>

        {isGpu && pool.gpu ? (
          <GpuBlocks t={t} gpu={pool.gpu} schedulableFree={readyGpu} className="mt-2" />
        ) : (
          <>
            {/* cells by pool size (barCells); phones cap at 48 so cells stay ≥ 3 px */}
            {[barCells(total, pool.nodes), Math.min(48, barCells(total, pool.nodes))].map((cells, i) => (
              <UnitBlocks
                key={i}
                free={free}
                used={used}
                reserved={cpuHeld.reserved}
                down={cpuHeld.down}
                total={total}
                unit={t("unit.cores")}
                cells={cells}
                className={cn("mt-2 w-full", i === 0 ? "hidden sm:flex" : "sm:hidden")}
              />
            ))}
          </>
        )}

        <div className="mt-2.5 flex flex-wrap items-center gap-x-4 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="h-2 w-2 rounded-full bg-ok/80" />
            <b className="tnum text-foreground">{pool.queue.running}</b> {t(pool.queue.running === 1 ? "queue.running1" : "queue.running")}
          </span>
          <span className="inline-flex items-center gap-1.5">
            {/* the same yellow as every "queues" bar and zone */}
            <span aria-hidden className={cn("h-2 w-2 rounded-full", pool.queue.pending ? "bg-warn/45" : "bg-muted")} />
            <b className="tnum text-foreground">{pool.queue.pending}</b> {t(pool.queue.pending === 1 ? "queue.pending1" : "queue.pending")}
          </span>
        </div>

        <div className="-mx-2 mt-3 border-t border-border pt-1.5">
          {pool.queue.running > 0 && (
            <>
              <DisclosureRow
                open={open}
                onToggle={() => setOpen(!open)}
                label={t("pool.occupants")}
                count={pool.queue.running}
              />
              {open && (
                <div className="px-2 pb-1.5">
                  <Occupants pool={pool} t={t} />
                </div>
              )}
            </>
          )}

          {pool.queue.pending > 0 && (
            <>
              <DisclosureRow
                open={queueOpen}
                onToggle={() => setQueueOpen(!queueOpen)}
                label={t("pool.pendingJobs")}
                count={pool.queue.pending}
              />
              {queueOpen && (
                <div className="px-2 pb-1.5">
                  <PendingJobs pool={pool} t={t} />
                </div>
              )}
            </>
          )}

          {!maint && <RequestSample pool={pool} t={t} />}
        </div>
      </CardContent>
    </Card>
  );
}

/** Full-width clickable expander row — the one affordance for every
 *  collapsible section on a pool card (occupants / pending / quick request). */
function DisclosureRow({
  open,
  onToggle,
  label,
  count,
  summary,
}: {
  open: boolean;
  onToggle: () => void;
  label: string;
  count?: number;
  summary?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className={cn(
        "flex min-h-8 w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground outline-none transition-colors",
        "hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/45",
        open && "text-foreground",
      )}
    >
      <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 transition-transform duration-150", open && "rotate-90")} />
      <span className="font-medium text-foreground/85">{label}</span>
      {count !== undefined && <span className="tnum font-mono">{count}</span>}
      {summary && <span className="ml-auto flex min-w-0 items-center gap-1.5 pl-2">{summary}</span>}
    </button>
  );
}

/** Collapsible starter request for this pool, in two steps: a table of its
 *  partitions on one axis (what a job may ask for, green = what starts now) to
 *  pick from, then that partition's request — sliders bounded by its limits,
 *  green up to what starts now — and the command. Picking a partition resets
 *  every field to that partition's defaults. */
function RequestSample({ pool, t }: { pool: Pool; t: TFn }) {
  const { snap } = useLive();
  // Minimal starter: the pool's sample partition (site file, else Slurm's
  // default partition) with no resource flags — the submit plugin and the
  // partition supply the defaults. Where they overflow a node,
  // `defaultRequestFit` derives the `-n` that pins the job to one node.
  const base = pool.sample_partition ? { partition: pool.sample_partition } : null;
  const [open, setOpen] = useState(false);
  const [partChoice, setPartChoice] = useState("");
  const [mode, setMode] = useState<"interactive" | "script">("interactive");
  // interactive has two command forms: plain salloc, or the batch-placeholder
  // recipe (srun --pty into a sleeping sbatch) — the only way to a shell with
  // a short, backfillable walltime on GPU partitions
  const [ptyOn, setPtyOn] = useState(false);
  const [scriptFile, setScriptFile] = useState("job.sh");
  const [nodes, setNodes] = useState("");
  const [cores, setCores] = useState("");
  const [mem, setMem] = useState("");
  // -t as Slurm reads it; timeText is what the box shows while typing
  const [time, setTime] = useState("");
  const [timeText, setTimeText] = useState("");
  // multi-GPU layout (key from gpuLayouts); "1" = the partition's default
  const [gpuKey, setGpuKey] = useState("1");
  const [msOpen, setMsOpen] = useState(false);
  // the -L picked for a partition that requires one (MatStudio)
  const [license, setLicense] = useState("");
  if (!base) return null;

  const isGpu = pool.kind === "gpu";
  const partition = pool.partitions.includes(partChoice) ? partChoice : base.partition;
  const selectPartition = (p: string) => {
    // a switch starts from that partition's own defaults
    setPartChoice(p);
    setNodes("");
    setCores("");
    setMem("");
    setTime("");
    setTimeText("");
    setGpuKey("1");
    setPtyOn(false);
    setLicense("");
  };
  const cap = partitionCap(partition, snap?.policy);
  const policy = partitionPolicy(partition, snap?.policy);
  const selectedPart = snap?.partitions.find((p) => p.name === partition);
  const groupRunning = snap ? partitionRunningJobs(snap.jobs, partition) : 0;
  // field bounds come from request-limits (shared with the daily boundary check)
  const limitShape: PoolShape = {
    nodes: selectedPart?.nodes ?? pool.nodes,
    coresPerNode: poolCoresPerNode(pool),
    memPerNodeMb: pool.mem_per_node,
    gpusPerNode: selectedPart?.spec.gpu_per_node ?? 0,
  };
  const baseLimits = requestLimits(partition, snap?.policy, limitShape, isGpu);
  const multiNodePolicy = baseLimits.multiNode;
  // Multi-GPU options this partition can really grant (QoS cores/memory/GPUs,
  // node shape). Anything else is not offered at all.
  const gpuShape: GpuNodeShape = {
    gpus: selectedPart?.spec.gpu_per_node ?? 0,
    cores: poolCoresPerNode(pool),
    memMb: pool.mem_per_node,
    count: pool.nodes,
  };
  const layoutFor = (p: string) =>
    gpuLayouts(partitionCap(p, snap?.policy), gpuShape, allowsMultiNode(partitionCap(p, snap?.policy), gpuShape.cores));
  const layoutResult = isGpu ? layoutFor(partition) : null;
  const layouts = layoutResult?.layouts ?? [];
  const layout = layouts.length > 1 ? layouts.find((l) => l.key === gpuKey) ?? null : null;
  const multiGpu = !!layout && layout.gpus > 1;

  const gpuFit = snap && isGpu ? gpuFitSnapshot(snap, pool, cap, partition) : null;
  const memRaw = mem.trim();
  const normalizedMem = normalizeMem(memRaw);
  const parsedMemMb = normalizedMem ? parseMemoryInputMb(normalizedMem) : 0;
  // --mem is per node, and the true ceiling is min(QOS cap, RealMemory):
  // the QOS mem is the nominal hardware size, so e.g. GPU-S "512G" dies at
  // submit ("Requested node configuration is not available") — never let the
  // panel emit a request no node can hold.
  // The plugin's flagless request can exceed one node (measured: VM-CPU and
  // VM-GPU-L 476800 MB vs 469070 MB, VM-LM 3772800 MB vs 3754178 MB). Slurm
  // then spreads the job — VM-GPU-L takes a second H100 for one task — or
  // refuses it. Pin it back to one node and say why.
  const nodeShape = { cores: poolCoresPerNode(pool), memMb: pool.mem_per_node };
  const defaultFit = defaultRequestFit(partitionDefaultRequest(partition, snap?.policy), nodeShape);
  // every extra node the split lands on takes the plugin's per-node GPUs with it
  const overflowExtraGpus = isGpu && defaultFit
    ? (partitionDefaults(partition, snap?.policy).gpus_per_node ?? 0) * Math.max(0, defaultFit.nodesNeeded - 1)
    : 0;
  const singleNodeFlag = singleNodeCoreFlag(defaultFit);
  const effMemGb = baseLimits.maxMemGb;
  const maxMemMb = effMemGb ? effMemGb * 1024 : 0;
  const memTooHigh = parsedMemMb > 0 && maxMemMb > 0 && parsedMemMb > maxMemMb;
  const memValue = normalizedMem && !memTooHigh ? normalizedMem : "";
  const memError = memRaw && !normalizedMem
    ? t("pool.memInvalid")
    : memTooHigh
      ? t("pool.memTooHigh", { max: `${effMemGb}G` })
      : "";
  const memOverrideMb = memValue ? parsedMemMb : 0;
  const effectiveGpuFit = gpuFit && memOverrideMb > 0 ? gpuFitWithMemOverride(gpuFit, memOverrideMb) : gpuFit;
  const pendingActive = snap && isGpu ? contendersForPool(snap, pool.id) : [];
  const queueFact = snap ? poolQueueFact(snap.jobs, snap.part_pool, pool.id, isGpu, pool, effectiveGpuFit?.schedulable ?? 0) : null;
  const limits = policyLimitRows(policy, groupRunning, t);
  const groupLimitReached = Boolean(policy.grpJobs && groupRunning >= policy.grpJobs);
  // Values outside the partition's bounds count as unset: LARGE-class QOS
  // rejects -c under MinTRES at submit, while flagless requests are shaped
  // up to the minimum automatically, so the default is the safe fallback.
  // -N bounds (request-limits): multi-node CPU partitions only, never more
  // nodes than the partition has, the QoS cores allow, or tasks to place
  const coreCountRaw = withinCapInt(cores, cap.maxCores, cap.minCores);
  const nodeLimit = requestLimits(partition, snap?.policy, limitShape, isGpu, coreCountRaw).maxNodes;
  const nodeCount = nodeLimit > 0 ? withinCapInt(nodes, nodeLimit) : 0;
  // tasks must cover the nodes: an -n below the chosen -N cannot be placed
  const coreCount = nodeCount && coreCountRaw && coreCountRaw < nodeCount ? 0 : coreCountRaw;
  // Same rule for -t vs the partition wall (mirrors --mem's memTooHigh).
  const wallSec = parseWallMinutes(cap.wall) * 60;
  const timeSel = time.trim() && (!wallSec || parseWalltimeSec(time) <= wallSec) ? time : "";
  const cpuRows = snap && !isGpu ? cpuProbeRows(pool, snap) : [];
  const partDefaults = partitionDefaults(partition, snap?.policy);
  const memPerCore = partDefaults.def_mem_per_cpu_mb ?? 0;
  // the plugin's default cores — or, where that overflows one node, the -n
  // the command pins it to (then the verdict must judge that pinned request)
  const overflowPinned = Boolean(defaultFit && !defaultFit.fitsOneNode);
  const defCores = overflowPinned && defaultFit ? defaultFit.maxCoresOnOneNode : (partDefaults.cores ?? 0);
  const hasAdvancedOverrides = Boolean(nodeCount || coreCount || memValue || timeSel);
  const selectedCpuRow = !hasAdvancedOverrides && !overflowPinned ? cpuRows.find((row) => row.partition === partition) ?? null : null;
  // salloc can't take the -t deal (plugin forces the walltime); the displayed
  // command's effective walltime decides what a tip may promise. The pty
  // variant of interactive rides on sbatch, so its -t is honored.
  const ptyActive = mode === "interactive" && isGpu && ptyOn;
  // the walltime job_submit.lua pins on salloc in this partition (null = -t honoured)
  const pinnedSec = interactiveForcedSec(partition, snap?.policy);
  const pinnedLabel = interactiveForcedLabel(partition, snap?.policy) ?? "";
  const forcedSec = mode === "interactive" && !ptyActive ? pinnedSec : null;
  // pty defaults to the walltime a plain interactive session would have had
  // (none pinned -> leave -t to Slurm) — pick a shorter -t to slip into a gap
  const ptyTime = timeSel || (pinnedSec ? minutesToSlurmTime(pinnedSec / 60) : "");
  const requestSec = forcedSec
    ?? (parseWalltimeSec(ptyActive ? ptyTime : timeSel) || Number.POSITIVE_INFINITY);
  const nowMs = Date.now();
  // A full group cap blocks every new job in the partition — no --mem value
  // bypasses QOSGrpJobsLimit, so the tip would be a false promise there.
  const gpuTip = isGpu && gpuFit && gpuFit.schedulable <= 0 && !groupLimitReached
    ? gpuFitTipCommand(gpuFit, pool, pendingActive, nowMs, requestSec)
    : null;
  // When the queue owns the slot (no --mem bypass possible), a reservation's
  // start time still bounds a backfill gap a short-walltime job can use.
  const bfTip = isGpu && gpuFit && !gpuTip && !groupLimitReached
    ? gpuBackfillTipCommand(gpuFit, pool, pendingActive, nowMs, requestSec)
    : null;
  // Interactive mode: the tip must either say "switch to script mode" or,
  // when the gap already holds the pinned walltime, reduce to the --mem part.
  // mem-less + gap ≥ pinned needs no tip — the verdict flips to "can start".
  const bfWindowSec = bfTip ? parseWalltimeSec(bfTip.t) : 0;
  const bfVariant: "script" | "switch" | "fits" | null = !bfTip
    ? null
    : forcedSec === null
      ? "script"
      : bfWindowSec >= forcedSec
        ? (bfTip.mem ? "fits" : null)
        : "switch";
  const defaultGpuBlocked = Boolean(isGpu && gpuFit && gpuFit.rawFree > 0 && gpuFit.schedulable <= 0);
  const showGpuFitDetails = Boolean(defaultGpuBlocked && !memValue);
  // in interactive mode each partition is judged with its own plugin-forced walltime
  const optionVerdictSec = mode === "interactive" && !ptyActive
    ? undefined
    : (parseWalltimeSec(ptyActive ? ptyTime : timeSel) || Number.POSITIVE_INFINITY);
  const baseQueueHint = selectedCpuRow
    ? null
    : requestQueueHint({
        part: selectedPart,
        policy,
        groupRunning,
        nodeCount,
        coreCount,
        multiNode: multiNodePolicy,
        isGpu,
        poolFree: snap ? poolCapacity(snap, pool.id) : null,
        queueFact,
        gpuFit: effectiveGpuFit,
        pendingActive,
        // the plugin-forced walltime, not the -t field, is what Slurm sees
        userTimeSec: forcedSec ?? parseWalltimeSec(ptyActive ? ptyTime : timeSel),
        t,
      });
  // CPU: the live judgement of the request the command actually carries
  // (fields, a pinned -n, an -L the command adds). The sbatch --test-only
  // probe only speaks for the bare default command, below.
  const cpuOverrideState = !isGpu && snap
    ? liveCpuStart(snap, partition, { cores: coreCount || defCores, nodes: nodeCount, memMb: memOverrideMb })
    : null;
  const queueHint = cpuOverrideState === "now"
    ? { tone: "ok" as const, label: t("pool.queueHintCanStart"), detail: "" }
    : cpuOverrideState === "queued"
      ? (baseQueueHint?.tone === "warn" ? baseQueueHint : { tone: "warn" as const, label: t("pool.queueHintWillQueue"), detail: "" })
      : baseQueueHint;
  // A multi-GPU layout needs whole idle nodes (packed) or nodes with a free
  // GPU and a GPU's share of cores (spread) — judge exactly that.
  const layoutHint = multiGpu && layout && snap && !groupLimitReached
    ? multiGpuQueueHint(layout, snap, pool, gpuShape, memPerCore, t)
    : null;
  const shownHint = layoutHint ?? queueHint;
  const script = scriptFile.trim() || "job.sh";
  // pty recipe (verified live): the wait loop redraws one status line while
  // the placeholder queues — srun errors with "Job is pending execution" if
  // attached too early — and pasting the whole block makes scancel fire when
  // the shell exits, so the placeholder never idles to its limit.
  const clusterLicenses = snap?.licenses ?? [];
  const licPlan = licensePlan(partDefaults, clusterLicenses, license, t("pool.licensePlaceholder"));
  const licFlag = licPlan.flag ? [licPlan.flag] : [];
  // A partition whose submit plugin sets no GPU default hands out none: name
  // the model and count. (Hakusan's plugin gives one GPU per node, so its
  // commands carry no --gres for a single GPU.)
  const gpuType = isGpu && !partDefaults.gpus_per_node ? pool.gpu?.type : undefined;
  const withGpuType = (flags: string[]) => !gpuType
    ? flags
    : flags.some((f) => f.startsWith("--gres=gpu:"))
      ? flags.map((f) => f.replace(/^--gres=gpu:(\d+)$/, `--gres=gpu:${gpuType}:$1`))
      : [...flags, `--gres=gpu:${gpuType}:1`];
  const cmd = buildRequestCommand({
    partition,
    // a GPU layout fixes nodes/cores/memory itself
    requiredFlags: withGpuType(multiGpu && layout
      ? [...licFlag, ...layout.flags]
      : [...licFlag, ...(singleNodeFlag ? [singleNodeFlag] : [])]),
    nodeCount: multiGpu ? undefined : nodeCount,
    coreCount: multiGpu ? undefined : coreCount,
    multiNode: multiNodePolicy,
    memValue: multiGpu ? undefined : memValue,
    timeValue: timeSel,
    forcedInteractiveSeconds: forcedSec,
    mode,
    pty: ptyActive,
    ptyTime,
    scriptFile: script,
  });
  // the scatter note is about the implicit multi-node DEFAULT — once the
  // user pins -N themselves it describes a state they already left
  const multiNodeCpuPolicy = !isGpu && multiNodePolicy && !nodeCount;
  const nodeOptions = nodeLimit > 0 ? numberOptions(nodeLimit, [1, 2, 3, 4, 8, 16, 32]) : [];

  // ---- the request the sliders show (unset fields show their default) -------
  const coresNow = coreCount || defCores;
  const perNodeCores = Math.max(1, Math.ceil(coresNow / (nodeCount || 1)));
  const defMemMb = perNodeCores * memPerCore;
  const memShownMb = memValue ? parsedMemMb : defMemMb;
  const coreMin = cap.minCores ?? 1;
  const coreMax = Math.max(coreMin, cap.maxCores ?? poolCoresPerNode(pool));
  const setCoreCount = (v: number) => setCores(v === defCores && !nodeCount ? "" : String(v));

  // -L decides first: no license where one is required, or a default name
  // the cluster lacks, is refused at submit; a used-up license queues
  const licenseRejected = (licPlan.kind === "required" && !license) || licPlan.kind === "missing";
  const licenseQueued = licenseBusy(licPlan);
  // a probe rejection applies only while the command is the probed one
  const probeRejected = Boolean(selectedCpuRow && !licPlan.flag && selectedCpuRow.state === "failed");

  // ---- what starts now, per slider -----------------------------------------
  // One rule for every track, with the other fields held as they are: green
  // = the values that start now, amber = the values the partition allows
  // that queue. A plain track = locked, or nothing to judge (no live data, a
  // command the cluster refuses). A cause no value of a slider fixes (the
  // group cap, a used-up license, no free GPU or cores at all) paints every
  // track amber and is said once, under the command; a cause a slider's own
  // value creates is said under that slider, with the value that fixes it.
  const judged = Boolean(snap) && !licenseRejected && !probeRejected;
  const blockedAll = groupLimitReached || licenseQueued;
  // the walltime the verdict judges (the pinned one for salloc)
  const verdictSec = forcedSec ?? parseWalltimeSec(ptyActive ? ptyTime : timeSel);
  // GPU: the request's own verdict at another --mem or walltime, so a zone
  // ends exactly where the verdict pill flips
  const gpuToneAt = (memMb: number, timeSec: number) => {
    if (!snap || !gpuFit) return null;
    const fit = memMb > 0 ? gpuFitWithMemOverride(gpuFit, memMb) : gpuFit;
    return requestQueueHint({
      part: selectedPart, policy, groupRunning, nodeCount, coreCount, multiNode: multiNodePolicy, isGpu,
      poolFree: poolCapacity(snap, pool.id),
      queueFact: poolQueueFact(snap.jobs, snap.part_pool, pool.id, isGpu, pool, fit.schedulable),
      gpuFit: fit, pendingActive, userTimeSec: timeSec, t,
    })?.tone ?? null;
  };

  // cores: the most that start now for the -N and --mem as set
  const cpuLimits = judged && !isGpu ? cpuStartLimits(snap!, partition, { nodes: nodeCount, memMb: memOverrideMb }) : null;
  const coreGreen = !cpuLimits ? undefined : blockedAll ? 0 : cpuLimits.maxCores;
  const coreHint = coreGreen !== undefined && coreGreen >= coreMin && coresNow > coreGreen
    ? (
        <>
          {t(cpuLimits?.spread ? "pool.hintCoresOverMulti" : "pool.hintCoresOverSingle", { n: coreGreen })}
          <HintAction label={t("pool.useCores", { n: coreGreen })} onClick={() => setCoreCount(coreGreen)} />
        </>
      )
    : null;
  // not even the smallest request fits: a pool-wide fact, said under the command
  const coreNoneReason = coreGreen === 0 && !blockedAll
    ? nodeCount ? t("pool.hintNodesNone", { n: nodeCount }) : t("pool.hintCoresNone", { n: coreMin })
    : null;

  // GPUs: one when the single-GPU request as set (its --mem, its walltime)
  // starts, more when a multi-GPU layout finds its nodes
  const gpuCounts = [...new Set(layouts.map((l) => l.gpus))].sort((a, b) => a - b);
  const gpuCount = layout?.gpus ?? 1;
  const showGpuSlider = isGpu && gpuCounts.length > 1;
  const gpuGreen = isGpu && judged
    ? blockedAll ? 0 : gpuStartCount(layouts, snap!, pool, gpuShape, memPerCore, queueHint?.tone === "ok", t)
    : undefined;
  const layoutStarts = (l: GpuLayout) => Boolean(snap) && multiGpuQueueHint(l, snap!, pool, gpuShape, memPerCore, t).tone === "ok";
  const setGpuCount = (n: number) => {
    const target = gpuCounts.reduce((best, c) => (Math.abs(c - n) < Math.abs(best - n) ? c : best), gpuCounts[0] ?? 1);
    if (target <= 1) {
      setGpuKey("1");
      return;
    }
    // of the placements for that count, the one that starts now wins
    const options = layouts.filter((x) => x.gpus === target);
    const l = options.find(layoutStarts) ?? options[0];
    if (l) setGpuKey(l.key);
  };
  const gpuHint = gpuGreen !== undefined && gpuGreen >= 1 && gpuCount > gpuGreen
    ? (
        <>
          {t("pool.hintGpuOver", { n: gpuGreen })}
          <HintAction label={t("pool.useGpus", { n: gpuGreen })} onClick={() => setGpuCount(gpuGreen)} />
        </>
      )
    : null;
  const gpuNoneReason = gpuGreen === 0 && !blockedAll
    ? pool.gpu?.next_free
      ? t("pool.hintGpuNoneNext", { gpu: pool.gpu.label, when: dayClockLabel(pool.gpu.next_free.at, t), n: Math.max(1, pool.gpu.next_free.gpus ?? 1) })
      : t("pool.hintGpuNone", { gpu: pool.gpu?.label ?? "GPU" })
    : null;
  const countLayouts = layouts.filter((l) => l.gpus === gpuCount && l.gpus > 1);
  // what the chosen layout's GPUs talk over — these nodes have no NVLink;
  // the network part only once the layout spans nodes
  const linkNote = multiGpu && layout && gpuShape.gpus > 1
    ? layout.nodes === 1
      ? t("pool.gpuLinkNode", { n: layout.gpusPerNode })
      : layout.gpusPerNode > 1
        ? t("pool.gpuLinkPacked", { n: layout.gpusPerNode })
        : t("pool.gpuLinkSpread")
    : "";
  // the count fits now, just not with the placement picked
  const startingAlt = multiGpu && layout && judged && !blockedAll && !layoutStarts(layout)
    ? countLayouts.find((l) => l.key !== layout.key && layoutStarts(l)) ?? null
    : null;

  // memory: a multi-GPU layout sets the per-node memory itself (locked)
  const layoutMemMb = multiGpu && layout ? layout.coresPerGpu * layout.gpusPerNode * memPerCore : 0;
  // CPU, no -N and no --mem on a multi-node partition, and no node holds
  // all the cores: each node gets DefMemPerCPU x its share — no one value
  const memSpreadLinked = Boolean(judged && !isGpu && !memValue && !nodeCount && cpuDefaultSpreads(snap!, partition, coresNow));
  // CPU: the exact --mem where liveCpuStart flips for the cores and -N as
  // set; GPU: the request's own verdict searched over whole GiB
  const memSearchMb = !judged || layoutMemMb > 0 || !effMemGb
    ? undefined
    : blockedAll
      ? 0
      : isGpu
        ? largestPassing(1, effMemGb, (gb) => gpuToneAt(gb * 1024, verdictSec) === "ok") * 1024
        : cpuStartMemMb(snap!, partition, coresNow, nodeCount);
  // the default point agrees with the verdict pill (GPU's own default
  // memory can sit between two whole GiB)
  const memGreenMb = isGpu && memSearchMb !== undefined && !blockedAll && !memValue
    ? queueHint?.tone === "ok" ? Math.max(memSearchMb, defMemMb) : Math.min(memSearchMb, Math.max(0, defMemMb - 1))
    : memSearchMb;
  // the stranded node the --mem bypass names, when it is that node's memory
  const memNode = gpuTip && memGreenMb !== undefined
    && gpuFit?.stranded.some((r) => r.node.name === gpuTip.node && Math.floor(r.freeMemMb / 1024) === Math.floor(memGreenMb / 1024))
    ? gpuTip.node
    : "";
  // without -N the cores may land on several nodes, each needing the --mem
  const memSpreads = !isGpu && judged && !nodeCount && memGreenMb !== undefined
    && memGreenMb > cpuStartMemMb(snap!, partition, coresNow, 1);
  const memFix = memGreenMb !== undefined && memGreenMb >= 1024 ? fmtGb(memGreenMb) : "";
  const memHint = memFix && !memSpreadLinked && memShownMb > memGreenMb!
    ? (
        <>
          {isGpu
            ? memNode
              ? t("pool.hintMemOverGpuNode", { mem: memFix, node: memNode })
              : t("pool.hintMemOverGpu", { mem: memFix })
            : memSpreads
              ? t("pool.hintMemOverSpread", { mem: memFix, cores: coresNow })
              : t("pool.hintMemOverCpu", { mem: memFix, cores: perNodeCores })}
          <HintAction label={t("pool.useMem", { mem: memFix })} onClick={() => setMem(memFix)} />
        </>
      )
    : null;
  // the default as a value box shows it: rounded, but never past the ceiling
  // (GPU-1: 26 x 9845 MB = 249.97G under a 249G limit)
  const defMemLabel = fmtGbNear(effMemGb ? Math.min(defMemMb, effMemGb * 1024) : defMemMb);
  // only the default point itself means "no --mem": any other position is an
  // explicit request (4 x 6000M rounds to 23G, but 23G is less than it asks)
  const setMemGb = (gb: number) => setMem(Math.abs(gb * 1024 - defMemMb) < 1 ? "" : `${Math.round(gb)}G`);

  // -t: shown always; locked where the plugin pins the interactive walltime
  const timeLocked = forcedSec !== null;
  const showTimeSlider = wallSec > 0 || timeLocked;
  const timeMax = Math.max(wallSec, pinnedSec ?? 0);
  const timeMin = Math.min(600, timeMax);
  const timeDefaultSec = timeLocked ? (forcedSec ?? timeMax) : ptyActive && pinnedSec ? pinnedSec : wallSec;
  const timeShownSec = timeLocked ? timeDefaultSec : timeSel ? parseWalltimeSec(timeSel) : timeDefaultSec;
  // the longest walltime that still starts now: one GPU — the verdict
  // searched over whole minutes (a backfill gap ends it); a CPU or
  // multi-GPU start does not depend on it
  const timeGreenSec = !judged || !showTimeSlider
    ? undefined
    : blockedAll
      ? 0
      : isGpu && !multiGpu
        ? largestPassing(Math.ceil(timeMin / 60), Math.floor(timeMax / 60), (m) => gpuToneAt(memOverrideMb, m * 60) === "ok") * 60
        : (isGpu ? layoutHint?.tone : cpuOverrideState === "now" ? "ok" : null) === "ok" ? timeMax : 0;
  const setTimeSec = (sec: number) => {
    setTimeText("");
    // only the default point itself means "no -t"
    setTime(Math.abs(sec - timeDefaultSec) < 1 ? "" : minutesToSlurmTime(Math.max(1, Math.round(sec / 60))));
  };
  // salloc's pinned walltime is not the user's value: the backfill tip
  // (a gap shell) is the fix there, not this hint
  const timeHint = !timeLocked && timeGreenSec !== undefined && timeGreenSec >= timeMin && timeShownSec > timeGreenSec
    ? (
        <>
          {bfTip
            ? t("pool.hintTimeOver", { t: durText(t, timeGreenSec), node: bfTip.node, until: clockShort(bfTip.untilMs) })
            : t("pool.hintTimeOverPlain", { t: durText(t, timeGreenSec) })}
          <HintAction label={t("pool.useTime", { t: durText(t, timeGreenSec) })} onClick={() => setTimeSec(timeGreenSec)} />
        </>
      )
    : null;
  // from the pinned interactive walltime: a new -t is a batch job
  const switchToScriptTime = (sec: number) => {
    if (timeLocked && Math.abs(sec - timeShownSec) < 1) return;
    setMode("script");
    setTimeText("");
    setTime(wallSec && Math.abs(sec - wallSec) < 1 ? "" : minutesToSlurmTime(Math.max(1, Math.round(sec / 60))));
  };
  const typedSec = parseHumanTime(timeText);
  const timeError = timeText.trim()
    ? !typedSec
      ? t("pool.timeInvalid")
      : wallSec && typedSec > wallSec
        ? t("pool.timeTooHigh", { max: wallText(t, cap.wall) })
        : null
    : null;

  const baseVerdict = probeRejected
    ? { tone: cpuProbeTone("failed"), label: cpuProbeLabel("failed", t) }
    : shownHint
      ? { tone: shownHint.tone, label: shownHint.label }
      : null;
  const verdict = licenseRejected
    ? { tone: "bad" as const, label: t("pool.verdictRejected") }
    : licenseQueued && baseVerdict?.tone === "ok"
      ? { tone: "warn" as const, label: t("pool.queueHintWillQueue") }
      : baseVerdict;
  const sliderHintShown = Boolean(coreHint || memHint || timeHint || startingAlt || gpuHint);
  // the backfill box below the command carries its own reason and fix
  const bfTipShown = Boolean(bfTip && bfVariant && (bfVariant !== "script" || bfTip.mem));
  // a reason no slider owns goes under the command
  const commandReason = licPlan.kind === "required" && !license
    ? t("pool.licenseRequired", { p: partition })
    : licPlan.kind === "missing"
      ? t("pool.licenseMissing", { bad: licPlan.pluginDefault ?? "" })
      : licenseQueued && licPlan.license
        ? t("pool.licenseBusy", { name: licPlan.license.name, used: licPlan.license.used, total: licPlan.license.total })
        : groupLimitReached && policy.grpJobs
          ? t("pool.groupFullReason", { p: partition, n: groupRunning, max: policy.grpJobs })
          : verdict?.tone !== "warn" || sliderHintShown || bfTipShown
            ? null
            : gpuNoneReason ?? coreNoneReason ?? (shownHint?.detail && !showGpuFitDetails ? shownHint.detail : null);
  const probeFailed = probeRejected && selectedCpuRow ? cpuProbeDetail(selectedCpuRow, "failed", t) : "";

  // ---- the partition table -------------------------------------------------
  const mainParts = pool.partitions.filter((p) => !isLicensePartition(p, snap?.policy));
  const msParts = pool.partitions.filter((p) => isLicensePartition(p, snap?.policy));
  const showTable = Boolean(snap) && (mainParts.length > 1 || msParts.length > 0);
  const rowFor = (p: string): PartitionTableRow => {
    const capP = partitionCap(p, snap?.policy);
    const policyP = partitionPolicy(p, snap?.policy);
    const fullP = Boolean(snap && policyP.grpJobs && partitionRunningJobs(snap.jobs, p) >= policyP.grpJobs);
    const wall = capP.wall ? wallText(t, capP.wall) : "—";
    const desc = trMaybe(t, `policy.${p}.desc`, "") || undefined;
    if (isGpu) {
      const summary = snap ? partitionRequestSummary(pool, snap, p, true, pendingActive, nowMs, t, optionVerdictSec) : null;
      const pLayouts = layoutFor(p).layouts;
      const hi = Math.max(1, ...pLayouts.map((l) => l.gpus));
      const now = snap && !fullP
        ? gpuStartCount(pLayouts, snap, pool, gpuShape, partitionDefaults(p, snap.policy).def_mem_per_cpu_mb ?? 0, summary?.hint?.tone === "ok", t)
        : 0;
      return {
        name: p, title: desc, lo: 1, hi, now, wall, perUser: perUserText(policyP.maxJobsPerUser),
        verdict: partitionOptionVerdict(summary, t), judged: Boolean(snap),
        selected: p === partition, marker: p === partition ? gpuCount : undefined,
      };
    }
    const lim = snap ? cpuStartLimits(snap, p) : null;
    const lo = capP.minCores ?? 1;
    const row = cpuRows.find((r) => r.partition === p);
    // what the panel's command for this row gets, -L included
    const planP = licensePlan(partitionDefaults(p, snap?.policy), clusterLicenses, "", "");
    const live = snap ? liveCpuStart(snap, p) ?? "unknown" : "unknown";
    const state = planP.flag ? live : row?.state ?? live;
    const rowVerdict = planP.kind === "required"
      ? { tone: "bad" as const, label: t("pool.needsL") }
      : planP.kind === "missing"
        ? { tone: "bad" as const, label: t("pool.verdictRejected") }
        : licenseBusy(planP) && state === "now"
          ? { tone: "warn" as const, label: t("pool.queueHintWillQueue") }
          : { tone: cpuProbeTone(state), label: cpuProbeLabel(state, t) };
    // the same rule as the sliders: a refused command is not judged, a
    // full group or a used-up license starts nothing
    const refused = planP.kind === "required" || planP.kind === "missing" || state === "failed";
    return {
      name: p, title: desc, lo, hi: Math.max(lo, capP.maxCores ?? poolCoresPerNode(pool)),
      now: lim && !lim.groupFull && !licenseBusy(planP) ? lim.maxCores : 0, wall, perUser: perUserText(policyP.maxJobsPerUser),
      verdict: rowVerdict, judged: Boolean(lim) && !refused,
      selected: p === partition, marker: p === partition ? coresNow : undefined,
    };
  };
  const perUserText = (n?: number) => (n ? t(n === 1 ? "users.job1" : "users.jobs", { n }) : undefined);
  // smallest first: the bars read as a staircase of job sizes, then by walltime
  const bySize = (a: PartitionTableRow, b: PartitionTableRow) =>
    a.lo - b.lo || a.hi - b.hi || wallLabelSec(partitionCap(a.name, snap?.policy).wall) - wallLabelSec(partitionCap(b.name, snap?.policy).wall);
  // a click on a bar in the table: that partition, with the value clicked
  const pickFromTable = (p: string, v: number) => {
    selectPartition(p);
    if (isGpu) {
      const ls = layoutFor(p).layouts;
      const counts = [...new Set(ls.map((l) => l.gpus))];
      const target = counts.reduce((best, c) => (Math.abs(c - v) < Math.abs(best - v) ? c : best), counts[0] ?? 1);
      const l = target > 1 ? ls.find((x) => x.gpus === target) : null;
      if (l) setGpuKey(l.key);
      return;
    }
    const d = partitionDefaults(p, snap?.policy).cores ?? 0;
    setCores(v === d ? "" : String(v));
  };
  const tableRows = showTable
    ? [...mainParts.map(rowFor).sort(bySize), ...(msOpen ? msParts.map(rowFor).sort(bySize) : [])]
    : [];
  const axisMax = Math.max(1, ...tableRows.map((r) => r.hi));
  const axis: PartitionAxis = isGpu
    ? { scale: "linear", min: 1, max: Math.max(2, axisMax), ticks: Array.from({ length: Math.max(2, axisMax) }, (_, i) => ({ value: i + 1, label: String(i + 1) })) }
    : { scale: "log", min: 1, max: Math.max(2, axisMax), ticks: logTicks(Math.max(2, axisMax)) };

  // Collapsed one-glance verdict for the row. Scan every partition and lead
  // with the most startable one — the default partition's "will queue · group
  // full" must not hide that a sibling policy can start (possibly via a tip).
  const collapsedPick = !open && snap
    ? bestPartitionPick(pool, snap, isGpu, pendingActive, cpuRows, t)
    : null;
  const rowSummary = collapsedPick ? (
    <>
      <Tag tone={collapsedPick.tone}>{collapsedPick.label}</Tag>
      {collapsedPick.text && (
        <span className="min-w-0 truncate text-xs text-muted-foreground">{collapsedPick.text}</span>
      )}
    </>
  ) : null;

  const perGpuCores = layout?.coresPerGpu || Math.max(1, Math.floor(gpuShape.cores / Math.max(1, gpuShape.gpus)));
  // columns follow the panel's own width (half-width cards too): three
  // fields sit side by side from @3xl; below that two per row, the third
  // taking the whole second row instead of leaving half of it empty
  const fieldCount = (isGpu ? (showGpuSlider ? 1 : 0) : 1) + 1 + (showTimeSlider ? 1 : 0);
  const sliderCols = fieldCount >= 3 ? "@lg:grid-cols-2 @3xl:grid-cols-3" : fieldCount === 2 ? "@lg:grid-cols-2" : "";
  const lastCellCls = fieldCount >= 3 ? "@lg:col-span-2 @3xl:col-span-1" : "";

  return (
    <>
      <DisclosureRow open={open} onToggle={() => setOpen(!open)} label={t("pool.quickRequest")} summary={rowSummary} />
      {open && (
        <div className="space-y-2.5 px-2 pb-2 pt-0.5">
          {showTable && (
            <PartitionTable
              rows={tableRows}
              axis={axis}
              onSelect={selectPartition}
              onPickValue={pickFromTable}
              quantize={isGpu ? Math.round : niceCoreCount}
              headers={{ name: t("col.partition"), wall: t("pool.tableWall"), perUser: t("pool.tablePerUser"), verdict: t("pool.tableVerdict") }}
              legend={{ range: t("pool.legendRange"), now: t("pool.legendNow") }}
              rangeLabels={!isGpu}
              footer={msParts.length > 0 ? (
                <button
                  type="button"
                  onClick={() => setMsOpen(!msOpen)}
                  aria-expanded={msOpen}
                  className="inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-muted/60 hover:text-foreground"
                >
                  <ChevronRight className={cn("h-3 w-3 transition-transform", msOpen && "rotate-90")} />
                  {t("pool.msGroup", { n: msParts.length })}
                </button>
              ) : undefined}
            />
          )}

          <div className="@container overflow-hidden rounded-lg border border-info/35 bg-card">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border/70 px-3 py-2">
              <span className="font-mono text-sm font-bold text-foreground">{partition}</span>
              <span className="flex-1" />
              {mode === "script" && (
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  {t("pool.scriptFile")}
                  <input
                    value={scriptFile}
                    onChange={(e) => setScriptFile(e.target.value)}
                    className="h-6 w-24 rounded-md border border-border bg-muted/40 px-2 font-mono text-xs text-foreground outline-none focus:border-primary"
                  />
                </label>
              )}
              <Segmented
                value={mode}
                onChange={setMode}
                ariaLabel={t("pool.mode")}
                options={[
                  { value: "interactive", label: t("pool.modeInteractive") },
                  { value: "script", label: t("pool.modeScript") },
                ]}
              />
            </div>

            <div className={cn("grid gap-x-7 gap-y-4 px-3 pb-3 pt-3", sliderCols)}>
              {isGpu ? (
                showGpuSlider && (
                  <div className="flex min-w-0 flex-col gap-2">
                    <RangeSlider
                      label={t("pool.gpuSlider")}
                      flag="--gres"
                      ariaLabel={t("pool.gpuSlider")}
                      min={1}
                      max={Math.max(2, gpuCounts[gpuCounts.length - 1] ?? 1)}
                      value={gpuCount}
                      onChange={setGpuCount}
                      snaps={gpuCounts}
                      green={gpuGreen}
                      greenLabel={gpuGreen && gpuGreen >= 1 ? String(gpuGreen) : undefined}
                      ticks={gpuCounts.map((c) => ({ value: c, label: String(c) }))}
                      valueBox={(
                        <SliderValueInput
                          value={gpuCount > 1 ? String(gpuCount) : ""}
                          placeholder="1"
                          ariaLabel={t("pool.gpuSlider")}
                          width="w-12"
                          onChange={(text) => {
                            const n = parseInt(text, 10);
                            if (n > 0) setGpuCount(n);
                            else if (!text.trim()) setGpuKey("1");
                          }}
                        />
                      )}
                      hint={gpuHint}
                    />
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      {countLayouts.length > 1 && (
                        <Segmented
                          value={layout?.key ?? countLayouts[0].key}
                          onChange={setGpuKey}
                          ariaLabel={t("pool.gpuSlider")}
                          options={countLayouts.map((l) => ({ value: l.key, label: layoutPlacementLabel(l, t) }))}
                          itemClassName="whitespace-nowrap"
                        />
                      )}
                      <span>{t("pool.perGpuShare", { cores: perGpuCores, mem: fmtGbNear(perGpuCores * memPerCore) })}</span>
                    </div>
                    {startingAlt && (
                      <p className="text-xs leading-snug text-warn-fg">
                        {t("pool.layoutAltStarts", { layout: layoutPlacementLabel(startingAlt, t) })}
                        <HintAction label={t("pool.useLayout")} onClick={() => setGpuKey(startingAlt.key)} />
                      </p>
                    )}
                  </div>
                )
              ) : (
                <RangeSlider
                  label={t("pool.cores")}
                  flag={multiNodePolicy ? "-n" : "-c"}
                  ariaLabel={t("pool.cores")}
                  min={coreMin}
                  max={coreMax}
                  value={Math.min(coreMax, Math.max(coreMin, coresNow))}
                  onChange={(v) => setCores(v === defCores && !nodeCount ? "" : String(v))}
                  snaps={[defCores, ...(coreGreen !== undefined ? [coreGreen] : []), ...linearTicks(coreMin, coreMax).map((tk) => tk.value)]}
                  green={coreGreen}
                  greenLabel={coreGreen !== undefined && coreGreen >= coreMin && coreGreen < coreMax ? String(coreGreen) : undefined}
                  ticks={linearTicks(coreMin, coreMax)}
                  valueBox={(
                    <SliderValueInput
                      value={cores}
                      placeholder={String(defCores)}
                      ariaLabel={t("pool.cores")}
                      onChange={setCores}
                    />
                  )}
                  hint={coreHint}
                />
              )}

              {layoutMemMb > 0 && effMemGb ? (
                <RangeSlider
                  label={t("kpi.memory")}
                  flag="--mem"
                  qualifier={t("pool.perNode")}
                  ariaLabel={t("kpi.memory")}
                  min={1}
                  max={effMemGb}
                  value={Math.min(effMemGb, layoutMemMb / 1024)}
                  onChange={() => {}}
                  ticks={[{ value: 1, label: "1G" }, { value: effMemGb, label: `${effMemGb}G` }]}
                  valueBox={<SliderValueFixed>{`${Math.min(Math.round(layoutMemMb / 1024), effMemGb)}G`}</SliderValueFixed>}
                  locked={t("pool.memLockedTip", { cores: layout!.coresPerGpu * layout!.gpusPerNode, per: fmtMemRaw(memPerCore), mem: `${Math.min(Math.round(layoutMemMb / 1024), effMemGb)}G` })}
                />
              ) : effMemGb ? (
                <RangeSlider
                  label={t("kpi.memory")}
                  flag="--mem"
                  qualifier={t("pool.perNode")}
                  labelExtra={!isGpu && memPerCore > 0 && (
                    <MemLinkToggle
                      linked={!memValue}
                      per={fmtMemRaw(memPerCore)}
                      onToggle={() => setMem(memValue ? "" : defMemLabel)}
                      t={t}
                    />
                  )}
                  ariaLabel={t("kpi.memory")}
                  min={1}
                  max={effMemGb}
                  value={Math.min(effMemGb, Math.max(1, memShownMb / 1024))}
                  onChange={setMemGb}
                  snaps={[...(memSpreadLinked ? [] : [defMemMb / 1024]), ...(memGreenMb && memGreenMb >= 1024 ? [Math.floor(memGreenMb / 1024)] : [])]}
                  green={memGreenMb !== undefined ? memGreenMb / 1024 : undefined}
                  greenLabel={memGreenMb !== undefined && memGreenMb >= 1024 && memGreenMb / 1024 < effMemGb ? fmtGb(memGreenMb) : undefined}
                  ticks={[{ value: 1, label: "1G" }, { value: effMemGb, label: `${effMemGb}G` }]}
                  thumb={!memSpreadLinked}
                  tip={memSpreadLinked ? t("pool.memSpreadTip", { per: fmtMemRaw(memPerCore) }) : undefined}
                  valueBox={(
                    <SliderValueInput
                      value={mem}
                      placeholder={memSpreadLinked ? t("pool.memPerCoreShort", { per: fmtMemRaw(memPerCore) }) : defMemLabel || t("pool.default")}
                      ariaLabel={t("kpi.memory")}
                      invalid={Boolean(memError)}
                      width={memSpreadLinked ? "w-28" : "w-[4.5rem]"}
                      onChange={setMem}
                    />
                  )}
                  hint={memHint}
                  error={memError || undefined}
                />
              ) : (
                <div className="flex min-w-0 flex-col gap-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <FieldLabel label={t("kpi.memory")} flag="--mem" qualifier={t("pool.perNode")} />
                    <SliderValueInput
                      value={mem}
                      placeholder={defMemLabel || t("pool.default")}
                      ariaLabel={t("kpi.memory")}
                      invalid={Boolean(memError)}
                      width="w-[4.5rem]"
                      onChange={setMem}
                    />
                  </div>
                  {memError && <p className="text-xs leading-snug text-bad-fg">{memError}</p>}
                </div>
              )}

              {showTimeSlider && <div className={cn("min-w-0", lastCellCls)}>{timeLocked ? (
                // salloc's walltime is pinned: moving it means batch, so
                // a drag or a typed time switches the mode and keeps the value
                <RangeSlider
                  label={t("pool.walltime")}
                  flag="-t"
                  ariaLabel={t("pool.walltime")}
                  scale="log"
                  min={timeMin}
                  max={timeMax}
                  value={timeShownSec}
                  onChange={switchToScriptTime}
                  quantize={quantizeWalltime}
                  snaps={[timeShownSec, ...(timeGreenSec && timeGreenSec >= timeMin ? [timeGreenSec] : []), ...walltimeTicks(timeMin, timeMax).map((tk) => tk.value)]}
                  green={timeGreenSec}
                  greenLabel={timeGreenSec !== undefined && timeGreenSec >= timeMin ? fmtDur(timeGreenSec) : undefined}
                  ticks={walltimeTicks(timeMin, timeMax)}
                  valueBox={(
                    <SliderValueInput
                      value=""
                      placeholder={pinnedLabel || fmtDur(timeShownSec)}
                      ariaLabel={t("pool.walltime")}
                      onChange={(text) => {
                        const sec = parseHumanTime(text);
                        setMode("script");
                        setTimeText(text);
                        if (sec > 0 && (!wallSec || sec <= wallSec)) setTime(minutesToSlurmTime(Math.max(1, Math.round(sec / 60))));
                      }}
                    />
                  )}
                  tip={t("pool.timeSwitchTip", { t: durText(t, timeShownSec) })}
                />
              ) : (
                <RangeSlider
                  label={t("pool.walltime")}
                  flag="-t"
                  ariaLabel={t("pool.walltime")}
                  scale="log"
                  min={timeMin}
                  max={timeMax}
                  value={Math.min(timeMax, Math.max(timeMin, timeShownSec))}
                  onChange={setTimeSec}
                  quantize={quantizeWalltime}
                  snaps={[timeDefaultSec, ...(timeGreenSec && timeGreenSec >= timeMin ? [timeGreenSec] : []), ...walltimeTicks(timeMin, timeMax).map((tk) => tk.value)]}
                  green={timeGreenSec}
                  greenLabel={timeGreenSec !== undefined && timeGreenSec >= timeMin ? fmtDur(timeGreenSec) : undefined}
                  ticks={walltimeTicks(timeMin, timeMax)}
                  valueBox={(
                    <SliderValueInput
                      value={timeText || (timeSel ? fmtDur(parseWalltimeSec(timeSel)) : "")}
                      placeholder={fmtDur(timeDefaultSec)}
                      ariaLabel={t("pool.walltime")}
                      invalid={Boolean(timeError)}
                      onChange={(text) => {
                        setTimeText(text);
                        const sec = parseHumanTime(text);
                        if (!text.trim()) setTime("");
                        else if (sec > 0 && (!wallSec || sec <= wallSec)) setTime(minutesToSlurmTime(Math.max(1, Math.round(sec / 60))));
                      }}
                    />
                  )}
                  hint={timeHint}
                  error={timeError || undefined}
                />
              )}</div>}
            </div>

            {/* the chosen GPU layout's interconnect, under the whole field grid */}
            {linkNote && (
              <div className="px-3 pb-3">
                <FieldNote>{linkNote}</FieldNote>
              </div>
            )}

            {licPlan.kind === "required" && clusterLicenses.length > 0 && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 pb-3 text-xs">
                <FieldLabel label={t("pool.licenseLabel")} flag="-L" />
                <div className="subtle-scroll min-w-0 max-w-full overflow-x-auto">
                  <Segmented
                    value={license}
                    onChange={setLicense}
                    ariaLabel={t("pool.licenseLabel")}
                    itemClassName="whitespace-nowrap font-mono"
                    options={clusterLicenses.map((l) => ({
                      value: l.name,
                      label: <>{l.name.split("@")[0]} <span className={l.free > 0 ? "text-ok-fg" : "text-warn-fg"}>{l.free}/{l.total}</span></>,
                    }))}
                  />
                </div>
              </div>
            )}

            {!multiGpu && nodeOptions.length > 0 && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 pb-3 text-xs">
                <FieldLabel label={t("pool.nodesLabel")} flag="-N" />
                {/* scrolls sideways on a phone instead of overflowing the card */}
                <div className="subtle-scroll min-w-0 max-w-full overflow-x-auto">
                  <Segmented
                    value={nodeCount ? String(nodeCount) : ""}
                    onChange={(v) => setNodes(v)}
                    ariaLabel={t("pool.nodesLabel")}
                    itemClassName="min-w-8 justify-center whitespace-nowrap font-mono"
                    options={[
                      { value: "", label: t("pool.nodesAuto") },
                      ...nodeOptions.map((n) => ({ value: String(n), label: String(n) })),
                    ]}
                  />
                </div>
                {/* what -N means here, for the state it is in */}
                {(nodeCount || multiNodeCpuPolicy) && (
                  <FieldNote>{nodeCount ? t("pool.nodeRequestHint") : t("pool.multiNodeHint")}</FieldNote>
                )}
              </div>
            )}

            <div className="space-y-1.5 px-3 pb-3">
              {/* terminal-styled on purpose (dark in both themes + $ prompt): with no
                  caption around it, the surface itself has to say "run this in a shell" */}
              <div className="flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-950 py-1.5 pl-2.5 pr-1.5">
                <span aria-hidden className="select-none self-start font-mono text-xs leading-5 text-zinc-500">$</span>
                <code className={cn("min-w-0 flex-1 overflow-x-auto font-mono text-xs leading-5 text-zinc-100", ptyActive ? "whitespace-pre" : "whitespace-nowrap")}>{cmd}</code>
                {verdict && <CommandVerdict tone={verdict.tone} label={verdict.label} />}
                <CopyButton text={cmd} label className="text-zinc-400 hover:bg-white/10 hover:text-zinc-100" />
              </div>
              {commandReason && <p className="text-xs leading-relaxed text-warn-fg">{commandReason}</p>}
              {probeFailed && <p className="text-xs leading-relaxed text-bad-fg">{probeFailed}</p>}
              {bfTip && bfVariant && (bfVariant !== "script" || bfTip.mem) && (
                <GpuBackfillQuickTip
                  tip={bfTip}
                  variant={bfVariant}
                  forced={wallText(t, pinnedLabel)}
                  applied={
                    bfVariant === "fits"
                      ? memValue === bfTip.mem
                      : bfVariant === "switch"
                        // still in interactive mode — the advice (switch to
                        // script) hasn't been taken even if -t/--mem match
                        ? false
                        : timeSel === bfTip.t && (!bfTip.mem || memValue === bfTip.mem)
                  }
                  onApply={() => {
                    const applied = bfVariant === "fits"
                      ? memValue === bfTip.mem
                      : bfVariant !== "switch" && timeSel === bfTip.t && (!bfTip.mem || memValue === bfTip.mem);
                    if (applied) {
                      // undo: clear what apply filled and drop back to salloc
                      if (bfTip.mem) setMem("");
                      if (bfVariant !== "fits") setTime("");
                      setPtyOn(false);
                      return;
                    }
                    if (bfTip.mem) setMem(bfTip.mem);
                    if (bfVariant !== "fits") {
                      setTime(bfTip.t);
                      setTimeText("");
                      // the user wanted interactive — flip the command to the
                      // pty recipe instead of sending them to a batch script
                      if (bfVariant === "switch") setPtyOn(true);
                    }
                  }}
                  t={t}
                />
              )}
              {/* active-recipe box only: usage note + the sole restore control */}
              {shouldShowGapShell({ isGpu, mode, ptyActive }) && (
                <div className="rounded-md border border-info/40 bg-info-soft/45 px-2 py-1.5 text-xs leading-relaxed">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Tag tone="info">{t("pool.ptyTag")}</Tag>
                    <span className="text-foreground">
                      {t("pool.ptyNote")}{!timeSel && <> {pinnedLabel ? t("pool.ptyNoteDefaultTime", { t: wallText(t, pinnedLabel) }) : t("pool.ptyNoteNoTime")}</>}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        // restore = a CLEAN plain-interactive state: drop the
                        // -t (meaningless there) and any tip-autofilled --mem;
                        // a hand-typed --mem survives
                        setPtyOn(false);
                        setTime("");
                        setTimeText("");
                        if (memValue && (memValue === bfTip?.mem || memValue === gpuTip?.mem)) setMem("");
                      }}
                      className="whitespace-nowrap rounded border border-info/45 bg-background/80 px-1.5 py-0.5 font-medium text-info-fg transition-colors hover:bg-info-soft"
                    >
                      {t("pool.ptyBack")}
                    </button>
                    {getSite().pages.slurm_guide && (
                      <Link to="/slurm#pty" className="whitespace-nowrap text-info-fg hover:underline">
                        {t("pool.scriptPtyMore")}
                      </Link>
                    )}
                  </div>
                </div>
              )}
              {/* each note appears only while the command carries what it explains */}
              <div className="space-y-0.5 text-xs leading-relaxed text-muted-foreground">
                {!multiGpu && coreCount > 0 && (
                  <p>{multiNodePolicy ? t("pool.taskFlagMany") : t("pool.taskFlagOne", { tasks: partDefaults.tasks ?? defCores })}</p>
                )}
                {/* Why the command carries a -n the user did not choose. Stated as
                    a fact about the partition, never as a note about our editing. */}
                {defaultFit && !defaultFit.fitsOneNode && !coreCount && (
                  <p>
                    {t("pool.defaultOverflow", {
                      partition,
                      n: defaultFit.maxCoresOnOneNode,
                      cores: defaultFit.cores,
                      per: fmtMemRaw(defaultFit.memPerCoreMb),
                      need: fmtMemRaw(defaultFit.memMb),
                      node: fmtMemRaw(defaultFit.node.memMb),
                    })}{" "}
                    {pool.nodes < defaultFit.nodesNeeded
                      ? t("pool.defaultOverflowRefused", { n: defaultFit.maxCoresOnOneNode })
                      : overflowExtraGpus > 0
                        ? t("pool.defaultOverflowSplitGpu", { n: defaultFit.maxCoresOnOneNode, nodes: defaultFit.nodesNeeded, gpus: overflowExtraGpus })
                        : t("pool.defaultOverflowSplit", { n: defaultFit.maxCoresOnOneNode, nodes: defaultFit.nodesNeeded })}
                  </p>
                )}
                {licPlan.kind === "default" && licPlan.license && (
                  <p>{t("pool.licenseAuto", { name: licPlan.license.name, free: licPlan.license.free, total: licPlan.license.total })}</p>
                )}
                {licPlan.kind === "fixed" && licPlan.license && (
                  <p className="text-warn-fg">{t("pool.licenseFixed", { bad: licPlan.pluginDefault ?? "", good: licPlan.license.name })}</p>
                )}
                {isGpu && mode === "script" && (
                  <p>
                    {t("pool.scriptPtyHint")}{" "}
                    {getSite().pages.slurm_guide && (
                      <Link to="/slurm#pty" className="whitespace-nowrap text-info-fg hover:underline">{t("pool.scriptPtyMore")}</Link>
                    )}
                  </p>
                )}
                {limits.length > 0 && (
                  <p>
                    {partition} · {limits.map((row) => row.label).join(" · ")}
                  </p>
                )}
              </div>
              {/* diagnostic detail last: when a fix makes it disappear, nothing above moves */}
              {showGpuFitDetails && gpuFit && <GpuFitExplanation fit={gpuFit} pendingActive={pendingActive} requestSec={requestSec} t={t} />}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** 🔗 between cores and --mem: linked, the memory is cores x the default
 *  per core and follows the core slider; a hand-set --mem unlinks it, and a
 *  click links it again (or pins the current value). */
function MemLinkToggle({ linked, per, onToggle, t }: { linked: boolean; per: string; onToggle: () => void; t: TFn }) {
  const Icon = linked ? Link2 : Link2Off;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onToggle}
          aria-pressed={linked}
          aria-label={linked ? t("pool.memLinkedTip", { per }) : t("pool.memUnlinkedTip")}
          className={cn(
            "ml-1 inline-flex h-5 w-5 items-center justify-center rounded transition-colors hover:bg-muted",
            linked ? "text-info-fg" : "text-muted-foreground",
          )}
        >
          <Icon className="h-3.5 w-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs leading-relaxed">
        {linked ? t("pool.memLinkedTip", { per }) : t("pool.memUnlinkedTip")}
      </TooltipContent>
    </Tooltip>
  );
}

/** The one-click fix after a hint: sets the value the hint names. */
function HintAction({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="ml-1.5 whitespace-nowrap font-medium text-info-fg underline-offset-2 hover:underline">
      {label}
    </button>
  );
}

/** The verdict pill inside the always-dark command box. */
function CommandVerdict({ tone, label }: { tone: Tone; label: string }) {
  const cls: Record<Tone, string> = {
    ok: "bg-emerald-500/15 text-emerald-300",
    warn: "bg-amber-500/15 text-amber-300",
    bad: "bg-red-500/15 text-red-300",
    info: "bg-sky-500/15 text-sky-300",
    neutral: "bg-zinc-500/20 text-zinc-300",
  };
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-semibold", cls[tone])}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}

/** Most GPUs one job in this partition starts with now: one when the
 *  single-GPU request starts as it stands (a --mem bypass is not applied
 *  until someone applies it), more when a multi-GPU layout finds its nodes. */
function gpuStartCount(layouts: GpuLayout[], snap: Snapshot, pool: Pool, shape: GpuNodeShape, memPerCore: number,
                       singleStarts: boolean, t: TFn) {
  const single = singleStarts ? 1 : 0;
  const multi = layouts
    .filter((l) => l.gpus > 1 && multiGpuQueueHint(l, snap, pool, shape, memPerCore, t).tone === "ok")
    .map((l) => l.gpus);
  return Math.max(single, ...multi);
}

function layoutPlacementLabel(l: GpuLayout, t: TFn) {
  if (l.nodes === 1) return t("pool.layoutOneNode", { n: l.gpus });
  return l.packed
    ? t("pool.layoutPackedN", { nodes: l.nodes, per: l.gpusPerNode })
    : t("pool.layoutSpreadN", { nodes: l.nodes });
}

/** A limit in whole GiB, rounded down: never promise memory that isn't there. */
const fmtGb = (mb: number) => (mb > 0 ? `${Math.floor(mb / 1024)}G` : "");
/** A default in GiB as the slider shows it (rounded). */
const fmtGbNear = (mb: number) => (mb > 0 ? `${Math.round(mb / 1024)}G` : "");

/** The largest integer in lo..hi a monotone test still passes (fewer
 *  resources never hurt); lo - 1 when none does. */
function largestPassing(lo: number, hi: number, ok: (v: number) => boolean) {
  if (hi < lo || !ok(lo)) return lo - 1;
  let a = lo;
  let b = hi;
  while (a < b) {
    const m = Math.ceil((a + b) / 2);
    if (ok(m)) a = m;
    else b = m - 1;
  }
  return a;
}

/** Ticks for a linear count axis: the ends plus ~3 round steps between. */
function linearTicks(lo: number, hi: number): SliderTick[] {
  const steps = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096];
  const step = steps.find((s) => (hi - lo) / s <= 4) ?? steps[steps.length - 1];
  const out: SliderTick[] = [{ value: lo, label: String(lo) }];
  for (let v = Math.ceil((lo + 1) / step) * step; v < hi; v += step) {
    if ((v - lo) / Math.max(hi - lo, 1) > 0.08) out.push({ value: v, label: String(v) });
  }
  out.push({ value: hi, label: String(hi) });
  return out;
}

/** A clicked point on the log core axis as a count a person would ask for:
 *  a power of two when close to one, else a round step for its size. */
function niceCoreCount(v: number) {
  const p2 = 2 ** Math.round(Math.log2(v));
  if (Math.abs(v - p2) / p2 < 0.12) return Math.max(1, p2);
  const step = v <= 16 ? 1 : v <= 256 ? 8 : 64;
  return Math.max(1, Math.round(v / step) * step);
}

const fmtCount = (v: number) => (v >= 1024 && v % 1024 === 0 ? `${v / 1024}K` : String(v));

/** Ticks for the table's log core axis: powers of four, and the end; the
 *  odd powers of two are minor (hidden on a phone-width bar). */
function logTicks(max: number) {
  const out = [1, 4, 16, 64, 256, 1024, 4096, 16384]
    .filter((v) => v <= max)
    .map((v) => ({ value: v, label: fmtCount(v), minor: v !== max && (Math.log2(v) % 4 !== 0 || Math.log2(max / v) < 1.5) }));
  // the end gets its own label; ticks within 1.5 octaves of it would touch
  if (max / out[out.length - 1].value >= 1.5) {
    return [...out.filter((tk) => Math.log2(max / tk.value) >= 1.5), { value: max, label: fmtCount(max), minor: false }];
  }
  return out;
}

const WALLTIME_TICKS: [number, string][] = [[600, "10m"], [3600, "1h"], [21600, "6h"], [86400, "1d"], [259200, "3d"], [604800, "7d"], [1209600, "14d"], [1814400, "21d"]];

/** Log-axis ticks for -t: the ends plus round steps, none closer than 15%
 *  of the track to a neighbour (so "3d" never sits on top of "7d"). */
function walltimeTicks(min: number, max: number): SliderTick[] {
  const pos = (v: number) => Math.log(v / min) / (Math.log(max / min) || 1);
  const out: SliderTick[] = [{ value: min, label: fmtDur(min) }];
  for (const [value, label] of WALLTIME_TICKS) {
    if (value <= min || value >= max) continue;
    if (pos(value) - pos(out[out.length - 1].value) < 0.15 || 1 - pos(value) < 0.15) continue;
    out.push({ value, label });
  }
  out.push({ value: max, label: fmtDur(max) });
  return out;
}

/** Round a dragged walltime to a step a person would type. */
function quantizeWalltime(sec: number) {
  const step = sec < 7200 ? 300 : sec < 86400 ? 1800 : 3600;
  return Math.max(step, Math.round(sec / step) * step);
}

/** "3d", "12h", "90m", "1d12h" or any Slurm -t form -> seconds (0 = unreadable). */
function parseHumanTime(text: string) {
  const s = text.trim().toLowerCase();
  if (!s) return 0;
  const m = s.match(/^(?:(\d+)\s*d)?\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?$/);
  if (m && (m[1] || m[2] || m[3])) return Number(m[1] || 0) * 86400 + Number(m[2] || 0) * 3600 + Number(m[3] || 0) * 60;
  return parseWalltimeSec(s);
}

/** Can this layout start now? Packed layouts need nodes with all GPUs free
 *  plus their cores; spread ones need nodes with a free
 *  GPU plus a GPU's share of cores and memory. Counted from the raw nodes. */
function multiGpuQueueHint(layout: GpuLayout, snap: Snapshot, pool: Pool, shape: GpuNodeShape,
                           memPerCpuMb: number, t: TFn) {
  const type = pool.gpu?.type ?? "";
  const coresPerGpu = layout.coresPerGpu;
  let fits = 0;
  for (const n of snap.nodes) {
    if (n.pool !== pool.id || !nodeIsSchedulable(n)) continue;
    const freeGpu = parseGpuCount(n.gres, type) - parseGpuCount(n.gres_used, type);
    const freeCores = n.cpus - n.alloc_cpus;
    const freeMem = n.real_memory - n.alloc_memory;
    const ok = layout.packed
      ? freeGpu >= shape.gpus && freeCores >= coresPerGpu * shape.gpus && freeMem >= coresPerGpu * shape.gpus * memPerCpuMb
      : freeGpu >= 1 && freeCores >= coresPerGpu && freeMem >= coresPerGpu * memPerCpuMb;
    if (ok) fits += 1;
  }
  const enough = fits >= layout.nodes;
  const key = layout.packed
    ? (enough ? "pool.gpuLayoutIdleOk" : "pool.gpuLayoutIdleShort")
    : (enough ? "pool.gpuLayoutSpreadOk" : "pool.gpuLayoutSpreadShort");
  return {
    tone: enough ? ("ok" as const) : ("warn" as const),
    label: t(enough ? "pool.queueHintCanStart" : "pool.queueHintWillQueue"),
    detail: t(key, { n: layout.nodes, m: fits }),
  };
}

/** A stored selection outside the (new) partition's bounds counts as "no
 *  selection" — clamping it silently would emit a flag the UI no longer
 *  shows. Bounds are two-sided: QOS MinTRES rejects too-small requests. */
function withinCapInt(value: string, max?: number, min?: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  const n = Math.floor(parsed);
  if (max && n > max) return 0;
  if (min && n < min) return 0;
  return n;
}

function normalizeMem(value: string) {
  const raw = value.trim().toUpperCase();
  if (!raw) return "";
  const m = raw.match(/^(\d+)([KMGTP])$/);
  if (!m) return "";
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return "";
  return `${Math.floor(n)}${m[2]}`;
}

function parseMemoryInputMb(value: string) {
  const m = normalizeMem(value).match(/^(\d+)([KMGTP])$/);
  if (!m) return 0;
  const n = Number(m[1]);
  const unit = m[2];
  const mult: Record<string, number> = { K: 1 / 1024, M: 1, G: 1024, T: 1024 * 1024, P: 1024 * 1024 * 1024 };
  return Math.round(n * mult[unit]);
}

function numberOptions(max: number | undefined, values: number[], min?: number) {
  const limit = max ?? Math.max(...values);
  const floor = min ?? 1;
  const out = new Set(values.filter((n) => n >= floor && n <= limit));
  if (max && max > 0) out.add(max);
  if (min && min > 0 && min <= limit) out.add(min);
  return [...out].sort((a, b) => a - b);
}

function parseWallMinutes(wall: string | undefined) {
  if (!wall) return 0;
  const m = wall.match(/^(\d+)([mhd])$/);
  if (!m) return 0;
  const n = Number(m[1]);
  if (m[2] === "m") return n;
  if (m[2] === "h") return n * 60;
  return n * 24 * 60;
}

function requestQueueHint({
  part,
  policy,
  groupRunning,
  nodeCount,
  coreCount,
  multiNode,
  isGpu,
  poolFree,
  queueFact,
  gpuFit,
  pendingActive,
  userTimeSec,
  t,
}: {
  part?: Partition;
  policy: PartitionPolicy;
  groupRunning: number;
  nodeCount: number;
  coreCount: number;
  multiNode: boolean;
  isGpu: boolean;
  poolFree: ReturnType<typeof poolCapacity> | null;
  queueFact: QueueFact | null;
  gpuFit: GpuFitInfo | null;
  pendingActive: RawJob[];
  userTimeSec: number;
  t: TFn;
}) {
  if (!part) return null;
  const warn = (detail: string) => ({ tone: "warn" as const, label: t("pool.queueHintWillQueue"), detail });
  const down = (part.nodes_state.down ?? 0) + (part.nodes_state.drain ?? 0);
  if (down >= part.nodes && part.nodes > 0) return warn(t("pool.queueReasonMaint"));
  if (policy.grpJobs && groupRunning >= policy.grpJobs) return warn(t("pool.queueReasonGroup"));
  if ((part.available_nodes ?? 0) <= 0) return warn(t("pool.queueReasonNoNode"));
  if (nodeCount > 0 && nodeCount > (part.available_nodes ?? 0)) return warn(t("pool.queueReasonNodes"));
  if (isGpu && (part.gpu?.free ?? 0) <= 0) return warn(t("pool.queueReasonNoGpu"));
  if (isGpu && gpuFit && gpuFit.rawFree > 0 && gpuFit.schedulable <= 0) {
    // Report the queue as the blocker when waiters can claim the free slot —
    // a memory-shortage message there would suggest a bypass that cannot work.
    const best = gpuFit.stranded.find((row) => row.freeGpu >= 1) ?? gpuFit.stranded[0];
    const c = best ? slotContention(best, pendingActive, Date.now()) : null;
    if (c && slotBlocked(c, userTimeSec > 0 ? userTimeSec : Number.POSITIVE_INFINITY)) {
      if (c.contenders > 0) return warn(t("pool.queueReasonContested", { n: c.contenders }));
      return warn(t("pool.queueReasonPlanned"));
    }
    return warn(gpuFitShortText(gpuFit, t));
  }
  if (isGpu && queueFact && queueFact.free <= 0 && (part.gpu?.free ?? 0) > 0) return warn(t("pool.queueReasonGpuFit"));
  // one task's CPUs must sit on one node; N tasks may scatter across nodes
  if (!isGpu && coreCount > 0 && poolFree
      && coreCount > (multiNode ? poolFree.freeCores : poolFree.emptiestNodeFree)) return warn(t("pool.queueReasonCores"));

  // CPU: a queue made only of limit-capped / dependency-held jobs takes no
  // free core — VM-CPU read "will queue" on 42 idle nodes behind one
  // Dependency job (2026-10-05)
  if (!isGpu && queueFact && queueFact.pending > 0 && queueFact.pending <= queueFact.limited) {
    return { tone: "ok" as const, label: t("pool.queueHintCanStart"), detail: t("pool.queueContentionClear", { n: queueFact.pending }) };
  }
  if (queueFact && queueFact.pending > 0) {
    // The request fits a free slot AND no queued job can take that slot first
    // (too big for it, group-capped, or fenced out by a reservation) —
    // backfill starts it despite the queue.
    if (isGpu && gpuFit && gpuFit.schedulable > 0
        && fitHasClearSlot(gpuFit, pendingActive, Date.now(), userTimeSec > 0 ? userTimeSec : Number.POSITIVE_INFINITY)) {
      return {
        tone: "ok" as const,
        label: t("pool.queueHintCanStart"),
        detail: t("pool.queueContentionClear", { n: queueFact.pending }),
      };
    }
    // Slot reserved for a queued job at a future start, but the user's -t
    // guarantees this request ends before then — backfill takes it now.
    if (isGpu && gpuFit && gpuFit.schedulable > 0
        && withinBackfillWindow(gpuFit, pendingActive, Date.now(), userTimeSec)) {
      return {
        tone: "ok" as const,
        label: t("pool.queueHintCanStart"),
        detail: t("pool.queueBfOk"),
      };
    }
    return {
      tone: "warn" as const,
      label: t("pool.queueHintQueued"),
      detail: queueFactText(queueFact, t),
    };
  }
  return { tone: "ok" as const, label: t("pool.queueHintCanStart"), detail: "" };
}

interface CollapsedPick {
  tone: Tone;
  label: string;
  text: string;
}

interface PartitionRequestSummary {
  partition: string;
  hint: { tone: Tone; label: string; detail: string } | null;
  gpuTip: GpuFitTipData | null;
  bfTip: GpuBackfillTipData | null;
}

interface PartitionOptionVerdict {
  tone: Tone;
  label: string;
}

function partitionOptionVerdict(
  summary: PartitionRequestSummary | null,
  t: TFn,
): PartitionOptionVerdict | null {
  if (!summary) return null;
  if (summary.hint?.tone === "ok") return { tone: "ok", label: t("pool.queueHintCanStart") };
  if (summary.gpuTip) return { tone: "warn", label: t("pool.optBypass") };
  if (summary.bfTip) return { tone: "info", label: t("pool.optGap") };
  if (summary.hint) return { tone: "warn", label: t("pool.queueHintWillQueue") };
  return null;
}

/** Collapsed quick-request row: lead with the pool's most startable partition.
 *  The default partition saying "will queue · group full" must not bury a
 *  sibling policy that can start — outright, via the --mem tip, or via the
 *  backfill window. */
function bestPartitionPick(
  pool: Pool,
  snap: Snapshot,
  isGpu: boolean,
  pendingActive: RawJob[],
  cpuRows: CpuProbeRow[],
  t: TFn,
): CollapsedPick | null {
  const multi = pool.partitions.length > 1;
  const prefix = (p: string, text: string) => (multi ? (text ? `${p} · ${text}` : p) : text);
  // CPU pool: sbatch --test-only probes already hold a per-partition verdict.
  if (!isGpu && cpuRows.length > 0) {
    const rank = (row: CpuProbeRow) => (row.state === "now" ? 0 : row.state === "queued" ? 2 : 3);
    const best = [...cpuRows].sort((a, b) => rank(a) - rank(b))[0];
    const state = best.state;
    return { tone: cpuProbeTone(state), label: cpuProbeLabel(state, t), text: `-p ${best.partition}` };
  }
  const nowMs = Date.now();
  const summaries = pool.partitions
    .filter((p) => !isLicensePartition(p, snap.policy))
    .map((p) => partitionRequestSummary(pool, snap, p, isGpu, pendingActive, nowMs, t))
    .filter((s): s is PartitionRequestSummary => s !== null);
  if (summaries.length === 0) return null;
  const rank = (s: PartitionRequestSummary) =>
    s.hint?.tone === "ok" ? 0 : s.gpuTip ? 1 : s.bfTip ? 2 : 3;
  const best = [...summaries].sort((a, b) => rank(a) - rank(b))[0];
  if (rank(best) === 1 && best.gpuTip) {
    return { tone: "warn", label: t("pool.fitTip"), text: prefix(best.partition, t("pool.quickGpuMemHint", { mem: best.gpuTip.mem })) };
  }
  if (rank(best) === 2 && best.bfTip) {
    return { tone: "info", label: t("pool.bfTip"), text: prefix(best.partition, t("pool.quickGpuBfHint", { t: best.bfTip.t })) };
  }
  if (best.hint) {
    return { tone: best.hint.tone, label: best.hint.label, text: prefix(best.partition, best.hint.detail) };
  }
  return null;
}

/** The quick-request verdict for one partition with no user overrides — the
 *  same pipeline the expanded panel runs for the selected partition. */
function partitionRequestSummary(
  pool: Pool,
  snap: Snapshot,
  partition: string,
  isGpu: boolean,
  pendingActive: RawJob[],
  nowMs: number,
  t: TFn,
  requestSecOverride?: number,
): PartitionRequestSummary | null {
  const part = snap.partitions.find((x) => x.name === partition);
  if (!part) return null;
  const policy = partitionPolicy(partition, snap.policy);
  // default: preview the interactive command with its plugin-forced walltime
  const requestSec = requestSecOverride ?? defaultRequestSec(partition, snap.policy);
  const advice = isGpu ? gpuPartitionAdvice(snap, pool, partition, pendingActive, nowMs, requestSec) : null;
  const groupRunning = advice?.groupRunning ?? partitionRunningJobs(snap.jobs, partition);
  const gpuFit = advice?.fit ?? null;
  const gpuTip = advice?.gpuTip ?? null;
  const bfTip = advice?.backfillTip ?? null;
  const queueFact = poolQueueFact(snap.jobs, snap.part_pool, pool.id, isGpu, pool, gpuFit?.schedulable ?? 0);
  const hint = requestQueueHint({
    part,
    policy,
    groupRunning,
    nodeCount: 0,
    coreCount: 0,
    multiNode: false,
    isGpu,
    poolFree: poolCapacity(snap, pool.id),
    queueFact,
    gpuFit,
    pendingActive,
    userTimeSec: Number.isFinite(requestSec) ? requestSec : 0,
    t,
  });
  return { partition, hint, gpuTip, bfTip };
}

interface QueueFact {
  pending: number;
  priority: number;
  limited: number;
  free: number;
  maxGpus: number;
  maxCpus: number;
  isGpu: boolean;
}

function poolQueueFact(jobs: RawJob[], partPool: Record<string, string>, poolId: string, isGpu: boolean, pool: Pool, schedulableGpuFree = 0): QueueFact {
  const pending = pendingForPool(jobs, partPool, poolId);
  const active = pending.filter((j) => !isLimitBlocked(j));
  const basis = active.length ? active : pending;
  return {
    pending: pending.length,
    priority: pending.filter((j) => j.state_reason === "Priority").length,
    limited: pending.filter(isLimitBlocked).length,
    free: isGpu ? schedulableGpuFree : pool.cores.free,
    maxGpus: Math.max(0, ...basis.map((j) => j.gpus || 0)),
    maxCpus: Math.max(0, ...basis.map((j) => j.cpus || 0)),
    isGpu,
  };
}

/** Why a request queues while something is free: the jobs the scheduler
 *  places first take it. One fact, not the queue's whole census. */
function queueFactText(fact: QueueFact, t: TFn) {
  const ahead = Math.max(0, fact.pending - fact.limited);
  if (fact.free <= 0 || ahead === 0) return t("pool.queueFactBusy");
  const free = fact.isGpu ? `${nf(fact.free)} ${t("unit.gpu")}` : coresText(t, fact.free);
  return t("pool.queueFactAhead", { free, n: ahead });
}

function GpuBackfillQuickTip({
  tip,
  variant,
  forced,
  applied,
  onApply,
  t,
}: {
  tip: GpuBackfillTipData;
  /** script: normal -t advice · switch: salloc can't -t, offer script mode · fits: gap ≥ the pinned walltime, only --mem needed */
  variant: "script" | "switch" | "fits";
  /** the plugin-pinned interactive walltime label ("12h"), from the policy */
  forced: string;
  applied: boolean;
  onApply: () => void;
  t: TFn;
}) {
  const until = clockShort(tip.untilMs);
  const text =
    variant === "switch"
      ? tip.mem
        ? t("pool.bfTipSalloc", { node: tip.node, until, mem: tip.mem, t: tip.t, forced })
        : t("pool.bfTipSallocTime", { node: tip.node, until, t: tip.t, forced })
      : variant === "fits"
        ? t("pool.bfTipFits", { node: tip.node, until, mem: tip.mem, forced })
        : tip.mem
          ? t("pool.bfTipText", { node: tip.node, until, mem: tip.mem, t: tip.t })
          : t("pool.bfTipTextTime", { node: tip.node, until, t: tip.t });
  const applyLabel =
    variant === "switch"
      ? t("pool.bfTipSallocApply")
      : variant === "fits"
        ? t("pool.fitTipApply", { mem: tip.mem })
        : tip.mem
          ? t("pool.bfTipApply", { mem: tip.mem, t: tip.t })
          : t("pool.bfTipApplyTime", { t: tip.t });
  return (
    <div className="mt-2 rounded-md border border-info/40 bg-info-soft/45 px-2 py-1.5 text-xs leading-relaxed">
      <div className="flex flex-wrap items-center gap-1.5">
        <Tag tone="info">{t("pool.bfTip")}</Tag>
        <span className="text-foreground">{text}</span>
        <button
          type="button"
          onClick={onApply}
          className={cn(
            "rounded border px-1.5 py-0.5 font-medium transition-colors",
            applied
              ? "border-ok/40 bg-ok-soft text-ok-fg"
              : "border-info/45 bg-background/80 text-info-fg hover:bg-info-soft",
          )}
        >
          {applied ? t("pool.fitTipApplied") : applyLabel}
        </button>
      </div>
    </div>
  );
}

/** "01:45" today, "7/9 01:45" once it crosses midnight. */
function clockShort(ms: number) {
  const d = new Date(ms);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return d.toDateString() === new Date().toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

/** Cores on one node of this pool — pools are homogeneous, so the pool total
 *  divided by its node count is the per-node figure Slurm sees. */
function poolCoresPerNode(pool: Pool) {
  return pool.nodes > 0 ? Math.floor(pool.cores.total / pool.nodes) : 0;
}

function trMaybe(t: TFn, key: string, fallback: string) {
  const translated = t(key as TranslationKey);
  return translated === key ? fallback : translated;
}

function GpuAvailabilityBreakdown({
  segments,
  t,
}: {
  segments: GpuAvailabilitySegment[];
  t: TFn;
}) {
  return (
    <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
      {segments.map((segment) => (
        <span key={segment.kind} className="inline-flex items-end gap-x-2">
          <b className={cn("tnum shrink-0 whitespace-nowrap text-2xl font-bold leading-none", gpuSegmentTextClass(segment.kind))}>
            {t("pool.gpuCount", { n: nf(segment.count) })}
          </b>
          <span className="text-xs leading-snug text-muted-foreground">
            {gpuSegmentLabel(segment.kind, t)}
          </span>
        </span>
      ))}
    </div>
  );
}

function strandedTipNode(fit: GpuFitInfo | null) {
  return fit?.stranded.find((row) => row.freeGpu >= 1 && row.freeCores >= fit.need.cores && row.freeMemMb > 1024) ?? null;
}

/** `requestSec`: how long the previewed request holds its slot (the plugin-
 *  pinned interactive walltime, or the chosen -t) — a slot or reservation gap
 *  must hold that much to count as free. */
function GpuFitExplanation({ fit, pendingActive, requestSec, t }: { fit: GpuFitInfo; pendingActive: RawJob[]; requestSec: number; t: TFn }) {
  const rows = fit.stranded.slice(0, 4);
  if (rows.length === 0) return null;
  const more = Math.max(0, fit.stranded.length - rows.length);
  const best = strandedTipNode(fit) ?? fit.stranded[0];
  const contention = best ? slotContention(best, pendingActive, Date.now()) : null;
  return (
    <div className="mt-2 rounded-md border border-warn/35 bg-warn-soft/45 px-2.5 py-2 text-xs leading-relaxed">
      <div className="flex flex-wrap items-center gap-1.5">
        <Tag tone="warn">{t("pool.fitBlocked")}</Tag>
        <span className="text-foreground">{t("pool.fitNeed", { partition: fit.need.partition, need: resourceText(fit.need, t) })}</span>
      </div>
      {contention && slotBlocked(contention, requestSec) && (
        <div className="mt-1 font-medium text-warn-fg">
          {contention.contenders > 0
            ? t("pool.fitContestedNote", { n: contention.contenders })
            : t("pool.fitPlannedNote")}
        </div>
      )}
      <div className="mt-1 text-muted-foreground">
        {t("pool.fitRawFree", { gpu: fit.rawFree, nodes: fit.stranded.length, sched: fit.schedulable })}
      </div>
      <div className="mt-1.5 space-y-1">
        {rows.map((row) => (
          <GpuFitNodeRow key={row.node.name} row={row} t={t} />
        ))}
      </div>
      {more > 0 && <div className="mt-1 text-muted-foreground">{t("pool.fitMoreNodes", { n: more })}</div>}
    </div>
  );
}

function GpuFitNodeRow({ row, t }: { row: GpuFitNode; t: TFn }) {
  const occupants = row.occupants.slice(0, 3);
  const more = Math.max(0, row.occupants.length - occupants.length);
  const allocated = allocatedResourceText(row, t);
  return (
    <div className="rounded-md border border-border/70 bg-background/70 px-2 py-1.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="font-mono text-info-fg">{row.node.name}</span>
        <span className="font-mono text-muted-foreground">
          {t("pool.fitNodeLeft", { free: nodeFreeText(row, t) })}
        </span>
        <span className="font-mono text-bad-fg">{t("pool.fitNodeMissing", { missing: missingText(row, t) })}</span>
      </div>
      {allocated && <div className="mt-0.5 font-mono text-muted-foreground">{t("pool.fitNodeAllocated", { used: allocated })}</div>}
      {occupants.length > 0 && (
        <div className="mt-0.5 text-muted-foreground">
          {t("pool.fitOccupants")}:{" "}
          {occupants.map((job, i) => (
            <span key={String(job.job_id)} className="font-mono">
              {i > 0 ? " · " : ""}
              {job.user_name} #{job.job_id} {job.partition} {jobResourceText(job, t)}
            </span>
          ))}
          {more > 0 && <span className="font-mono"> · +{more}</span>}
        </div>
      )}
    </div>
  );
}

function allocatedResourceText(row: GpuFitNode, t: TFn) {
  if (row.usedGpu <= 0 && row.node.alloc_cpus <= 0 && row.node.alloc_memory <= 0) return "";
  return resourceParts(row.usedGpu, row.node.alloc_cpus, row.node.alloc_memory, t);
}

function gpuFitShortText(fit: GpuFitInfo, t: TFn) {
  const best = fit.stranded[0];
  if (!best) return t("pool.queueReasonGpuFit");
  return t("pool.fitShort", {
    partition: fit.need.partition,
    need: resourceText(fit.need, t),
    node: best.node.name,
    free: nodeFreeText(best, t),
    missing: missingText(best, t),
  });
}

function resourceText(need: GpuFitNeed, t: TFn) {
  return resourceParts(need.gpus, need.cores, need.memMb, t);
}

function nodeFreeText(row: GpuFitNode, t: TFn) {
  return resourceParts(row.freeGpu, row.freeCores, row.freeMemMb, t);
}

function resourceParts(gpus: number, cores: number, memMb: number, t: TFn) {
  return `${nf(gpus)} ${t("unit.gpu")} / ${nf(cores)} ${t("unit.cores")} / ${fmtMemRaw(memMb)}`;
}

function jobResourceText(job: RawJob, t: TFn) {
  const parts = [];
  if (job.gpus) parts.push(`${nf(job.gpus)} ${t("unit.gpu")}`);
  if (job.cpus) parts.push(coresText(t, job.cpus));
  if (job.min_memory) parts.push(job.min_memory);
  return parts.length ? `(${parts.join(" / ")})` : "";
}

function missingText(row: GpuFitNode, t: TFn) {
  const parts = [];
  if (row.missingGpu > 0) parts.push(`${nf(row.missingGpu)} ${t("unit.gpu")}`);
  if (row.missingCores > 0) parts.push(coresText(t, row.missingCores));
  if (row.missingMemMb > 0) parts.push(`${fmtMemRaw(row.missingMemMb)} ${t("kpi.memory")}`);
  return parts.length ? parts.join(" / ") : "0";
}

function fmtMemRaw(mb: number) {
  return `${nf(Math.max(0, Math.round(mb)))}M`;
}

/** One block per physical GPU — ready (green), unavailable idle capacity
 * (amber, whether constrained or scheduler-reserved), used (red), then
 * genuinely offline (grey with an inset border). */
function GpuBlocks({ gpu, schedulableFree, className, t }: { gpu: PoolGpu; schedulableFree?: number; className?: string; t: TFn }) {
  const ready = Math.max(0, Math.min(gpu.free, schedulableFree ?? gpu.free));
  const stranded = Math.max(0, gpu.free - ready);
  const reserved = Math.max(0, gpu.reserved ?? 0);
  const seg = (n: number, cls: string, key: string) =>
    Array.from({ length: Math.max(0, n) }, (_, i) => (
      <span key={key + i} className={cn("h-2.5 min-w-0 flex-1 rounded-sm", cls)} />
    ));
  return (
    <div className={cn("flex gap-0.5", className)} title={[
      ready && t("blocks.ready", { n: `${ready} ${t("unit.gpu")}` }),
      stranded && t("blocks.constrained", { n: `${stranded} ${t("unit.gpu")}` }),
      reserved && t("blocks.reserved", { n: `${reserved} ${t("unit.gpu")}` }),
      gpu.used && t("blocks.used", { n: `${gpu.used} ${t("unit.gpu")}` }),
      gpu.down && t("blocks.down", { n: `${gpu.down} ${t("unit.gpu")}` }),
    ].filter(Boolean).join(" · ")}>
      {seg(ready, "bg-ok", "f")}
      {seg(stranded, "bg-warn", "s")}
      {seg(reserved, "bg-warn", "r")}
      {seg(gpu.used, "bg-bad", "u")}
      {seg(gpu.down, "bg-muted-foreground/25 ring-1 ring-inset ring-muted-foreground/45", "d")}
    </div>
  );
}

function isMaintPool(pool: Pool) {
  return pool.kind === "gpu" && !!pool.gpu?.maint;
}

function hasAvailableNodes(pool: Pool, snap: Snapshot) {
  if (isMaintPool(pool)) return false;
  if (pool.kind === "gpu") return poolGpuAvailability(snap, pool, Date.now()).ready > 0;
  return (pool.available_nodes ?? pool.idle_nodes ?? 0) > 0;
}

function PendingJobs({ pool, t }: { pool: Pool; t: TFn }) {
  const { snap } = useLive();
  if (!snap) return null;
  // every waiting job, in the order it gets its turn (the box scrolls)
  const list = nextUpOrder(pendingForPool(snap.jobs, snap.part_pool, pool.id));
  if (list.length === 0) return null;
  return (
    <div className="mt-2 max-h-64 space-y-1 overflow-y-auto pr-1">
      {list.map((j) => (
        <PendingJobRow key={String(j.job_id)} job={j} t={t} />
      ))}
    </div>
  );
}

function PendingJobRow({ job, t }: { job: RawJob; t: TFn }) {
  const rawReason = job.state_reason || "None";
  return (
    <div className="rounded-md bg-muted/40 px-2.5 py-1.5 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-info-fg">{job.user_name}</span>
        <div className="flex items-center gap-2 font-mono text-muted-foreground">
          <span>{job.partition}</span>
          <span className="text-foreground">{pendingJobResources(job, t)}</span>
        </div>
      </div>
      <div className="mt-1 truncate text-xs text-muted-foreground">
        {reasonLabel(t, rawReason)}
        {job.start_est && Number.isFinite(Date.parse(job.start_est)) && (
          <> · {t("pool.pendingStartEst", { when: dayClockLabel(job.start_est, t) })}</>
        )}
      </div>
    </div>
  );
}

function pendingJobResources(job: RawJob, t: TFn) {
  const parts = [];
  if (job.gpus > 0) parts.push(`${job.gpus} ${t("unit.gpu")}`);
  if (job.cpus > 0) parts.push(coresText(t, job.cpus));
  if ((job.min_memory_mb ?? 0) > 0) parts.push(fmtMB(job.min_memory_mb));
  if (job.node_count > 0) parts.push(`${job.node_count} ${t("spec.nodes")}`);
  return parts.join(" · ") || "—";
}

function Occupants({ pool, t }: { pool: Pool; t: TFn }) {
  const { snap } = useLive();
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"usage" | "ending">("ending");
  const [now, setNow] = useState(() => Date.now() / 1000); // ticks the live countdown
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(id);
  }, []);
  if (!snap) return null;

  const isGpu = pool.kind === "gpu";
  const all = occupantsForPool(snap, pool.id); // pre-sorted by resource usage
  const needle = q.trim().toLowerCase();
  const filtered = needle
    ? all.filter((o) => o.user.toLowerCase().includes(needle) || o.nodelist.toLowerCase().includes(needle))
    : all;
  let list = filtered;
  if (sort === "ending") {
    list = [...list].sort((a, b) => (a.end_time || "~").localeCompare(b.end_time || "~"));
  }
  const groupByUser = sort === "usage";
  const userGroups = groupByUser ? occupantUserGroups(filtered) : [];
  const totalUserGroups = groupByUser ? occupantUserGroups(all).length : 0;
  const shown = groupByUser ? userGroups.length : list.length;
  const total = groupByUser ? totalUserGroups : all.length;
  // One shared ruler for every row in this pool — the longest wall-time cap among the
  // partitions sharing this hardware. Otherwise a job that maxes out its own (shorter)
  // partition policy looks "full" even though a sibling partition allows much longer.
  const poolCapSeconds = Math.max(0, ...pool.partitions.map((p) => partitionWallSeconds(p, snap.policy)));
  return (
    <div className="mt-2">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("table.search")}
          aria-label={t("table.search")}
          className="h-7 w-40 rounded-md border border-border bg-background px-2 text-xs outline-none focus:border-primary"
        />
        <div className="flex items-center rounded-md border border-border p-0.5">
          {(["ending", "usage"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSort(s)}
              className={cn(
                "rounded px-2 py-0.5 text-xs transition-colors",
                sort === s ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t(s === "usage" ? "pool.sortUsage" : "pool.sortEnding")}
            </button>
          ))}
        </div>
        <span className="tnum ml-auto text-xs text-muted-foreground">
          {shown}/{total}
        </span>
      </div>
      {/* by usage: the pool as one map, each user's tile its share; a search
          narrows it to a list of the matching users */}
      {groupByUser && !needle ? (
        <OccupancyMap
          tiles={poolOccupancyTiles(pool, snap, userGroups, t)}
          ariaLabel={t("pool.sortUsage")}
          restLabel={(k, amount) => ({ label: t("users.others", { n: k }), amount: isGpu ? `${nf(amount)} ${t("unit.gpu")}` : coresText(t, amount) })}
          nodeWord={t("spec.nodes")}
          {...occupancyMode(pool, snap)}
        />
      ) : (
      <div className="max-h-72 space-y-1 overflow-y-auto pr-1">
        {groupByUser ? (
          userGroups.map((group) => (
            <OccupantUserRow key={group.user} group={group} isGpu={isGpu} t={t} />
          ))
        ) : (
          list.map((o) => (
            <OccupantRow key={String(o.job_id)} o={o} now={now} generatedAt={snap.generated_at} poolCap={poolCapSeconds} t={t} />
          ))
        )}
        {shown === 0 && (
          <div className="py-3 text-center text-xs text-muted-foreground">{t("table.noresults")}</div>
        )}
      </div>
      )}
    </div>
  );
}

/** Tiles for a pool's occupancy map: one per user (GPUs on a GPU pool,
 *  cores otherwise), then what is free and what is offline. */
function poolOccupancyTiles(pool: Pool, snap: Snapshot, groups: OccupantUserGroup[], t: TFn): OccupancyTile[] {
  const isGpu = pool.kind === "gpu" && !!pool.gpu;
  const unit = (n: number) => (isGpu ? `${nf(n)} ${t("unit.gpu")}` : coresText(t, n));
  const waiting = new Map<string, number>();
  for (const j of snap.jobs) {
    if (String(j.job_state).toUpperCase() !== "PENDING") continue;
    if (!String(j.partition || "").split(",").some((p) => snap.part_pool[p] === pool.id)) continue;
    waiting.set(j.user_name, (waiting.get(j.user_name) ?? 0) + 1);
  }
  const users: OccupancyTile[] = groups
    .map((g) => {
      const value = isGpu ? g.gpus : g.cpus;
      const queued = waiting.get(g.user) ?? 0;
      return {
        key: g.user,
        value,
        kind: "user" as const,
        label: g.user,
        amount: unit(value),
        sub: `${g.nodes} ${t("spec.nodes")}`,
        // the row layout prints one line: who, how much, how many nodes
        queued: queued > 0,
        details: [
          `${g.nodes} ${t("spec.nodes")} · ${t(g.jobs === 1 ? "users.job1" : "users.jobs", { n: g.jobs })}`,
          [isGpu ? coresText(t, g.cpus) : "", `${t("kpi.memory")} ${fmtMB(g.mem_mb)}`].filter(Boolean).join(" · "),
          ...(queued ? [t("users.queuedJobs", { n: queued })] : []),
        ],
      };
    })
    .sort((a, b) => b.value - a.value);
  const free = isGpu ? pool.gpu!.free : pool.cores.free;
  const held = isGpu ? { reserved: pool.gpu!.reserved ?? 0, down: pool.gpu!.down } : unschedulableCores(snap.nodes, pool.id);
  return [
    ...users,
    { key: "~free", value: free, kind: "free", amount: unit(free), sub: t("users.free"), details: [t("users.free")] },
    { key: "~reserved", value: held.reserved, kind: "reserved", amount: unit(held.reserved), sub: t("users.reserved"), details: [t("users.reservedDetail")] },
    { key: "~off", value: held.down, kind: "off", amount: unit(held.down), sub: t("users.offline"), details: [t("users.offline")] },
  ];
}

interface OccupantUserGroup {
  user: string;
  jobs: number;
  gpus: number;
  cpus: number;
  mem_mb: number;
  nodes: number;
}

function occupantUserGroups(list: Occupant[]): OccupantUserGroup[] {
  const map = new Map<string, OccupantUserGroup>();
  for (const o of list) {
    const g = map.get(o.user) ?? {
      user: o.user,
      jobs: 0,
      gpus: 0,
      cpus: 0,
      mem_mb: 0,
      nodes: 0,
    };
    g.jobs += 1;
    g.gpus += o.gpus;
    g.cpus += o.cpus;
    g.mem_mb += o.mem_mb;
    g.nodes += o.nodes;
    map.set(o.user, g);
  }
  return [...map.values()].sort(
    (a, b) =>
      b.gpus - a.gpus
      || b.cpus - a.cpus
      || b.mem_mb - a.mem_mb
      || b.jobs - a.jobs
      || a.user.localeCompare(b.user),
  );
}

function OccupantRow({
  o,
  now,
  generatedAt,
  poolCap,
  t,
}: {
  o: Occupant;
  now: number;
  generatedAt: number;
  poolCap: number;
  t: TFn;
}) {
  // live remaining = remaining-at-snapshot minus seconds elapsed since the snapshot
  const remaining = Math.max(0, parseDur(o.time_left) - (now - generatedAt));
  const requested = parseDur(o.time_limit);
  const cap = poolCap || requested;
  const remFrac = cap > 0 ? Math.min(1, remaining / cap) : 0;
  const requestedFrac = cap > 0 ? Math.min(1, requested / cap) : 0;
  // Short jobs in a long-cap partition (e.g. 12h in a 7d DEF slot) round to a sliver —
  // floor the *visible* width so they stay a readable bar instead of vanishing; the
  // color still reflects the true fraction, not the floored width.
  const barWidth = remFrac > 0 ? Math.max(3, remFrac * 100) : 0;
  // The bar means "how long this can still occupy resources, relative to what this
  // partition normally allows": short is good, long is expensive.
  const barColor = remFrac >= 0.5 ? "bg-bad" : remFrac >= 0.15 ? "bg-warn" : "bg-ok";
  return (
    <div className="rounded-md bg-muted/40 px-2.5 py-1.5 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-info-fg">{o.user}</span>
        <div className="flex items-center gap-2 font-mono text-muted-foreground">
          <span className="text-foreground">{occupantResources(o, t)}</span>
          <span className="max-w-[8rem] truncate">{o.nodelist}</span>
        </div>
      </div>
      <div className="mt-1 flex items-center gap-2">
        {/* Track = this partition's policy wall-time cap. Three zones, left to right:
            colored = time left, grey = already spent (of this job's own request),
            bare track = headroom this job will never touch because it asked for less
            than the partition allows. */}
        <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
          <div
            className={cn("absolute inset-y-0 left-0 transition-all duration-1000 ease-linear", barColor)}
            style={{ width: `${barWidth}%` }}
          />
          {requestedFrac * 100 > barWidth && (
            <div
              className="absolute inset-y-0 bg-muted-foreground/30 transition-all duration-1000 ease-linear"
              style={{ left: `${barWidth}%`, width: `${requestedFrac * 100 - barWidth}%` }}
            />
          )}
        </div>
        <span className="tnum shrink-0 font-mono text-xs">
          <span className="text-foreground">{fmtCountdown(remaining)}</span>
          {requested > 0 && <span className="text-muted-foreground"> / {fmtDur(requested)}</span>}
        </span>
      </div>
    </div>
  );
}

function OccupantUserRow({
  group,
  isGpu,
  t,
}: {
  group: OccupantUserGroup;
  isGpu: boolean;
  t: TFn;
}) {
  const primary = isGpu ? `${group.gpus} ${t("unit.gpu")}` : coresText(t, group.cpus);
  return (
    <div className="rounded-md bg-muted/40 px-2.5 py-1.5 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-info-fg">{group.user}</span>
        <span className="tnum rounded bg-info-soft px-1.5 py-0.5 font-mono text-xs font-semibold text-info-fg">
          {primary}
        </span>
      </div>
      <div className="mt-1 flex min-w-0 items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="truncate">
          {group.jobs} {t("topusers.jobs")}
          {/* the chip above has the headline; the line repeats it among the rest */}
          {isGpu && <> · {group.gpus} {t("unit.gpu")}</>}
          {isGpu && <> · {coresText(t, group.cpus)}</>} · {fmtMB(group.mem_mb)}
          {group.nodes > 0 && <> · {group.nodes} {t("spec.nodes")}</>}
        </span>
      </div>
    </div>
  );
}

function partitionWallSeconds(partition: string, policy?: Snapshot["policy"]) {
  const part = String(partition || "").split(",")[0];
  const wall = partitionCap(part, policy).wall;
  return parseWallMinutes(wall) * 60;
}

function occupantResources(o: Occupant, t: TFn) {
  const parts = [];
  if (o.gpus > 0) parts.push(`${o.gpus} ${t("unit.gpu")}`);
  if (o.cpus > 0) parts.push(coresText(t, o.cpus));
  if (o.mem_mb > 0) parts.push(fmtMB(o.mem_mb));
  return parts.join(" · ") || "—";
}
