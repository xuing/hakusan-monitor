// The quick request: a pool's partitions on one axis, then the chosen
// partition's request — sliders bounded by its limits, green up to what starts
// now — and the command. Verdicts come from lib/gpu-partition and
// lib/cpu-partition, the same the Partitions page reads.
import { useState } from "react";
import { Link } from "react-router";
import { ChevronRight } from "lucide-react";
import { CopyButton } from "@/components/common/copy-button";
import {
  FieldLabel,
  FieldNote,
  RangeSlider,
  SliderValueFixed,
  SliderValueInput,
} from "@/components/common/range-slider";
import { Segmented } from "@/components/common/segmented";
import { aheadText, dayClockLabel, fmtMemRaw, gpuReasonText, gpuVerdictTag, layoutPlacementLabel } from "@/components/common/verdict-text";
import { Tag } from "@/components/common/tag";
import { PartitionTable, type PartitionAxis, type PartitionTableRow } from "@/components/request/partition-table";
import { useLive } from "@/hooks/live-context";
import { useNow } from "@/hooks/use-now";
import { coresText, durText, tOptional, wallText, type TFn } from "@/i18n";
import { clusterClock } from "@/lib/cluster-time";
import { cpuPartitionStatus, cpuPartitionVerdict } from "@/lib/cpu-partition";
import {
  cpuDefaultSpreads,
  cpuProbeRows,
  cpuStartLimits,
  cpuStartMemMb,
  liveCpuStart,
  type CpuProbeState,
} from "@/lib/cpu-probes";
import { defaultRequestFit, singleNodeCoreFlag } from "@/lib/default-request";
import { coresPerNode, poolCapacity } from "@/lib/derive";
import { fmtDur } from "@/lib/format";
import { gpuFitSnapshot } from "@/lib/gpu-fit";
import { gpuLayouts, type GpuLayout, type GpuNodeShape } from "@/lib/gpu-layout";
import { gpuStartCount, gpuStatus, layoutFit } from "@/lib/gpu-partition";
import { licenseBusy, licensePlan } from "@/lib/licenses";
import { cpuProbeDetail, cpuProbeLabel, cpuProbeTone, policyLimitRows } from "@/lib/policy-hints";
import { poolPick } from "@/lib/pool-status";
import { poolContenders, poolWaiters, queueModel } from "@/lib/queue";
import { buildRequestCommand, shouldShowGapShell } from "@/lib/request-command";
import { requestLimits, type PoolShape } from "@/lib/request-limits";
import { getSite } from "@/lib/site";
import { allowsMultiNode, interactiveForcedLabel, interactiveForcedSec, isLicensePartition, minutesToSlurmTime, parseWalltimeSec, partitionCap, partitionDefaultRequest, partitionDefaults, partitionDown, partitionPolicy, type Tone, wallLabelSec } from "@/lib/slurm";
import { cn } from "@/lib/utils";
import type { Partition, Pool, Snapshot } from "@/types/snapshot";
import { DisclosureRow } from "@/components/pools/pool-card";
import { CommandVerdict, GpuBackfillQuickTip, GpuFitExplanation, HintAction, MemLinkToggle } from "@/components/request/request-parts";
import { fmtGb, fmtGbNear, largestPassing, linearTicks, logTicks, niceCoreCount, normalizeMem, numberOptions, parseHumanTime, parseMemoryInputMb, quantizeWalltime, walltimeTicks, withinCapInt } from "@/lib/request-input";

/** Collapsible starter request for this pool, in two steps: a table of its
 *  partitions on one axis (what a job may ask for, green = what starts now) to
 *  pick from, then that partition's request — sliders bounded by its limits,
 *  green up to what starts now — and the command. Picking a partition resets
 *  every field to that partition's defaults. */
export function RequestPanel({ pool, t }: { pool: Pool; t: TFn }) {
  const { snap } = useLive();
  const nowMs = useNow();
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
  const q = snap ? queueModel(snap) : null;
  const groupRunning = q ? q.running(partition) : 0;
  // field bounds come from request-limits (shared with the daily boundary check)
  const limitShape: PoolShape = {
    nodes: selectedPart?.nodes ?? pool.nodes,
    coresPerNode: coresPerNode(pool),
    memPerNodeMb: pool.mem_per_node,
    gpusPerNode: selectedPart?.spec.gpu_per_node ?? 0,
  };
  const baseLimits = requestLimits(partition, snap?.policy, limitShape, isGpu);
  const multiNodePolicy = baseLimits.multiNode;
  // Multi-GPU options this partition can really grant (QoS cores/memory/GPUs,
  // node shape). Anything else is not offered at all.
  const gpuShape: GpuNodeShape = {
    gpus: selectedPart?.spec.gpu_per_node ?? 0,
    cores: coresPerNode(pool),
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
  const nodeShape = { cores: coresPerNode(pool), memMb: pool.mem_per_node };
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
  const contenders = snap && isGpu ? poolContenders(snap, pool.id) : [];
  const limits = policyLimitRows(policy, groupRunning, t);
  const groupLimitReached = Boolean(q?.groupFull(partition));
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
  const wallSec = wallLabelSec(cap.wall);
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
  // ---- the verdict: the same functions the partition table and the
  // Partitions page read (lib/gpu-partition, lib/cpu-partition) ----
  // the walltime the verdict judges (the pinned one for salloc)
  const verdictSec = forcedSec ?? parseWalltimeSec(ptyActive ? ptyTime : timeSel);
  const gpu = snap && isGpu ? gpuStatus(snap, pool, partition, { memMb: memOverrideMb, timeSec: verdictSec }, nowMs) : null;
  // the --mem bypass and the backfill gap name a value for the DEFAULT
  // request; a full group cap blocks every request, so neither exists there
  const gpuTip = gpu?.memTip ?? null;
  const bfTip = gpu?.gapTip ?? null;
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
    : parseWalltimeSec(ptyActive ? ptyTime : timeSel);
  // CPU: the default request reads the partition's status, as its table row
  // does; set fields or a pinned -n are judged live as the command carries them
  const cpuState: CpuProbeState | null = !isGpu && snap
    ? hasAdvancedOverrides || overflowPinned
      ? liveCpuStart(snap, partition, { cores: coreCount || defCores, nodes: nodeCount, memMb: memOverrideMb, timeSec: verdictSec || undefined })
      : cpuPartitionStatus(snap, partition).state
    : null;
  // A multi-GPU layout needs whole idle nodes (packed) or nodes with a free
  // GPU and a GPU's share of cores (spread) — judge exactly that.
  const layoutCheck = multiGpu && layout && snap && !groupLimitReached ? layoutFit(snap, pool, partition, layout) : null;
  const startsLabel = (starts: boolean) => t(starts ? "verdict.now" : "verdict.queue");
  const shown: { tone: Tone; label: string; detail: string } | null = layoutCheck && layout
    ? {
        tone: layoutCheck.starts ? "ok" : "warn",
        label: startsLabel(layoutCheck.starts),
        detail: t(layout.packed
          ? (layoutCheck.starts ? "pool.gpuLayoutIdleOk" : "pool.gpuLayoutIdleShort")
          : (layoutCheck.starts ? "pool.gpuLayoutSpreadOk" : "pool.gpuLayoutSpreadShort"), { n: layout.nodes, m: layoutCheck.fits }),
      }
    : gpu
      ? { tone: gpu.now ? "ok" : "warn", label: startsLabel(Boolean(gpu.now)), detail: gpuReasonText(gpu, t) }
      : cpuState === "now" || cpuState === "queued"
        ? {
            tone: cpuState === "now" ? "ok" : "warn",
            label: startsLabel(cpuState === "now"),
            detail: cpuState === "queued" && snap ? cpuQueueDetail(snap, pool, selectedPart, { nodeCount, coreCount, multiNode: multiNodePolicy }, t) : "",
          }
        : null;
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
  const coreMax = Math.max(coreMin, cap.maxCores ?? coresPerNode(pool));
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
  // GPU: the request's own verdict at another --mem or walltime, so a zone
  // ends exactly where the verdict pill flips
  const gpuStartsAt = (memMb: number, timeSec: number) =>
    Boolean(snap) && gpuStatus(snap!, pool, partition, { memMb, timeSec }, nowMs).now !== null;

  // cores: the most that start now for the -N and --mem as set
  const cpuLimits = judged && !isGpu ? cpuStartLimits(snap!, partition, { nodes: nodeCount, memMb: memOverrideMb, timeSec: verdictSec || undefined }) : null;
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
    ? blockedAll ? 0 : gpuStartCount(snap!, pool, partition, { memMb: memOverrideMb, timeSec: verdictSec })
    : undefined;
  const layoutStarts = (l: GpuLayout) => Boolean(snap) && layoutFit(snap!, pool, partition, l).starts;
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
  const memSpreadLinked = Boolean(judged && !isGpu && !memValue && !nodeCount && cpuDefaultSpreads(snap!, partition, coresNow, verdictSec || undefined));
  // CPU: the exact --mem where liveCpuStart flips for the cores and -N as
  // set; GPU: the request's own verdict searched over whole GiB
  const memSearchMb = !judged || layoutMemMb > 0 || !effMemGb
    ? undefined
    : blockedAll
      ? 0
      : isGpu
        ? largestPassing(1, effMemGb, (gb) => gpuStartsAt(gb * 1024, verdictSec)) * 1024
        : cpuStartMemMb(snap!, partition, coresNow, nodeCount, verdictSec || undefined);
  // the default point agrees with the verdict pill (GPU's own default
  // memory can sit between two whole GiB)
  const memGreenMb = isGpu && memSearchMb !== undefined && !blockedAll && !memValue
    ? gpu?.now ? Math.max(memSearchMb, defMemMb) : Math.min(memSearchMb, Math.max(0, defMemMb - 1))
    : memSearchMb;
  // the stranded node the --mem bypass names, when it is that node's memory
  const memNode = gpuTip && memGreenMb !== undefined
    && gpuFit?.stranded.some((r) => r.node.name === gpuTip.node && Math.floor(r.freeMemMb / 1024) === Math.floor(memGreenMb / 1024))
    ? gpuTip.node
    : "";
  // without -N the cores may land on several nodes, each needing the --mem
  const memSpreads = !isGpu && judged && !nodeCount && memGreenMb !== undefined
    && memGreenMb > cpuStartMemMb(snap!, partition, coresNow, 1, verdictSec || undefined);
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
        ? largestPassing(Math.ceil(timeMin / 60), Math.floor(timeMax / 60), (m) => gpuStartsAt(memOverrideMb, m * 60)) * 60
        : (isGpu ? layoutCheck?.starts : cpuState === "now") ? timeMax : 0;
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
            ? t("pool.hintTimeOver", { t: durText(t, timeGreenSec), node: bfTip.node, until: clusterClock(bfTip.untilMs) })
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
    : shown
      ? { tone: shown.tone, label: shown.label }
      : null;
  const verdict = licenseRejected
    ? { tone: "bad" as const, label: t("verdict.rejected") }
    : licenseQueued && baseVerdict?.tone === "ok"
      ? { tone: "warn" as const, label: t("verdict.queue") }
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
          ? groupRunning >= policy.grpJobs
            ? t("pool.groupFullReason", { p: partition, n: groupRunning, max: policy.grpJobs })
            : t("pool.groupTakenReason", { p: partition, n: groupRunning, max: policy.grpJobs, k: policy.grpJobs - groupRunning })
          : verdict?.tone !== "warn" || sliderHintShown || bfTipShown
            ? null
            : gpuNoneReason ?? coreNoneReason ?? (shown?.detail && !showGpuFitDetails ? shown.detail : null);
  const probeFailed = probeRejected && selectedCpuRow ? cpuProbeDetail(selectedCpuRow, "failed", t) : "";

  // ---- the partition table -------------------------------------------------
  const mainParts = pool.partitions.filter((p) => !isLicensePartition(p, snap?.policy));
  const msParts = pool.partitions.filter((p) => isLicensePartition(p, snap?.policy));
  const showTable = Boolean(snap) && (mainParts.length > 1 || msParts.length > 0);
  const rowFor = (p: string): PartitionTableRow => {
    const capP = partitionCap(p, snap?.policy);
    const policyP = partitionPolicy(p, snap?.policy);
    const fullP = Boolean(q?.groupFull(p));
    const wall = capP.wall ? wallText(t, capP.wall) : "—";
    const desc = tOptional(t, `policy.${p}.desc`) || undefined;
    if (isGpu) {
      const req = { timeSec: optionVerdictSec };
      const status = snap ? gpuStatus(snap, pool, p, req, nowMs) : null;
      const hi = Math.max(1, ...layoutFor(p).layouts.map((l) => l.gpus));
      return {
        name: p, title: desc, lo: 1, hi, now: snap && !fullP ? gpuStartCount(snap, pool, p, req) : 0, wall,
        perUser: perUserText(policyP.maxJobsPerUser), verdict: status ? gpuVerdictTag(status, t) : null, judged: Boolean(snap),
        selected: p === partition, marker: p === partition ? gpuCount : undefined,
      };
    }
    const lo = capP.minCores ?? 1;
    // the same status the Partitions page shows for this partition
    const st = snap ? cpuPartitionStatus(snap, p) : null;
    // the same rule as the sliders: a refused command is not judged, a
    // full group or a used-up license starts nothing
    const refused = !st || st.license.kind === "required" || st.license.kind === "missing" || st.state === "failed";
    return {
      name: p, title: desc, lo, hi: Math.max(lo, capP.maxCores ?? coresPerNode(pool)),
      now: st?.maxCores ?? 0, wall, perUser: perUserText(policyP.maxJobsPerUser),
      verdict: st ? cpuPartitionVerdict(st, t) : { tone: cpuProbeTone("unknown"), label: cpuProbeLabel("unknown", t) }, judged: !refused,
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

  // Collapsed one-glance verdict for the row: the pool's most startable
  // partition (lib/pool-status poolPick) — the default partition's "will
  // queue · group full" must not hide that a sibling policy can start. The
  // pool's dot reads the same pick.
  const collapsedPick = !open && snap ? pickSummary(snap, pool, t) : null;
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
              {showGpuFitDetails && gpuFit && <GpuFitExplanation fit={gpuFit} contenders={contenders} t={t} />}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** The collapsed quick-request row: the pool's most startable partition
 *  (poolPick), worded as its table row and the Partitions page word it. */
function pickSummary(snap: Snapshot, pool: Pool, t: TFn): { tone: Tone; label: string; text: string } | null {
  const pick = poolPick(snap, pool);
  if (!pick) return null;
  const prefix = (text: string) => (pool.partitions.length > 1 ? (text ? `${pick.partition} · ${text}` : pick.partition) : text);
  if (pick.kind === "cpu") return { ...cpuPartitionVerdict(pick.status, t), text: `-p ${pick.partition}` };
  const s = pick.status;
  const waiting = poolWaiters(snap, pool.id).length;
  const text = s.now === "clear"
    ? waiting > 0 ? t("pool.queueContentionClear", { n: waiting }) : ""
    : !s.now && s.memTip
      ? t("pool.quickGpuMemHint", { mem: s.memTip.mem })
      : !s.now && s.gapTip
        ? t("pool.quickGpuBfHint", { t: s.gapTip.t })
        : gpuReasonText(s, t);
  return { ...gpuVerdictTag(s, t), text: prefix(text) };
}

/** Why a CPU request queues, when no slider owns the reason. */
function cpuQueueDetail(snap: Snapshot, pool: Pool, part: Partition | undefined,
                        req: { nodeCount: number; coreCount: number; multiNode: boolean }, t: TFn): string {
  if (!part) return "";
  if (partitionDown(part)) return t("pool.queueReasonMaint");
  if ((part.available_nodes ?? 0) <= 0) return t("pool.queueReasonNoNode");
  if (req.nodeCount > (part.available_nodes ?? 0)) return t("pool.queueReasonNodes");
  const free = poolCapacity(snap, pool.id);
  if (req.coreCount > 0 && req.coreCount > (req.multiNode ? free.freeCores : free.emptiestNodeFree)) return t("pool.queueReasonCores");
  const ahead = poolContenders(snap, pool.id).length;
  return ahead > 0 ? aheadText(ahead, pool.cores.free > 0 ? coresText(t, pool.cores.free) : null, t) : "";
}

