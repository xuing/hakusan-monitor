import { Fragment, useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { Bar } from "@/components/common/bar";
import { CopyButton } from "@/components/common/copy-button";
import { Tag } from "@/components/common/tag";
import { Card, CardContent } from "@/components/ui/card";
import { useLive } from "@/hooks/use-live";
import { useResourceFilter } from "@/hooks/use-resource-filter";
import { poolLabel, reasonLabel, useT, type TFn, type TranslationKey } from "@/i18n";
import { occupantsForPool, poolCapacity } from "@/lib/derive";
import { clockOf, fmtCountdown, fmtDur, fmtMB, nf, parseDur } from "@/lib/format";
import {
  PolicyLimitChips,
  cpuProbeDetail,
  cpuProbeLabel,
  cpuProbeTone,
  fmtPolicyLimit,
  policyLimitRows,
} from "@/lib/policy-hints";
import {
  conservativeMemGb,
  contendersForPool,
  fitHasClearSlot,
  gpuBackfillTipCommand,
  gpuFitSnapshot,
  gpuFitTipCommand,
  gpuFitWithMemOverride,
  isLimitBlocked,
  parseWalltimeSec,
  pendingForPool,
  schedulableGpuSlots,
  slotBlocked,
  slotContention,
  withinBackfillWindow,
  type GpuBackfillTipData,
  type GpuFitInfo,
  type GpuFitNeed,
  type GpuFitNode,
  type GpuFitTipData,
} from "@/lib/gpu-fit";
import { isMaterialsStudioPartition, matchPool, partitionCap, partitionPolicy, type PartitionPolicy, type Tone } from "@/lib/slurm";
import { cn } from "@/lib/utils";
import { cpuProbeRows, cpuProbeState, type CpuProbeRow } from "@/lib/cpu-probes";
import type { Occupant, Partition, Pool, PoolGpu, RawJob, Snapshot } from "@/types/snapshot";

// Hakusan's job_submit.lua overrides -t on every interactive (salloc) job —
// set, not capped — to a per-partition-class constant. Measured live 2026-07:
// GPU partitions (incl. VM-GPU-L) → "time limit is set to 720 minutes"; CPU/
// VM/LM partitions → "2880 minutes"; TINY alone honors -t (5-min salloc ran
// as requested). Batch (sbatch) keeps its -t everywhere. Walltime-based
// verdicts and tips must use these values in interactive mode; short--t
// tricks are only deliverable through script mode.
function interactiveForcedSec(partition: string, isGpu: boolean): number | null {
  if (partition === "TINY") return null;
  return (isGpu ? 720 : 2880) * 60;
}

// Minimal starter per pool. Hakusan's submit plugin applies the partition
// defaults, including the GPU partition's default one GPU per node.
const SAMPLE: Record<string, { partition: string; requiredFlags?: string[] }> = {
  "vm-cpu": { partition: "VM-CPU" },
  cpu: { partition: "DEF" },
  lm: { partition: "VM-LM", requiredFlags: ["-n 1"] },
  a40: { partition: "GPU-1" },
  a100: { partition: "GPU-1A" },
  "h100-80": { partition: "VM-GPU-L" },
};

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
      <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("section.pools")}</h2>
      <div className="space-y-5">
        {groups.map((g) => (
          <PoolGroup key={g.key} label={g.label} pools={g.pools} snap={snap} t={t} />
        ))}
      </div>
    </div>
  );
}

function PoolGroup({ label, pools, snap, t }: { label: string; pools: Pool[]; snap: Snapshot; t: TFn }) {
  const available = pools.filter((p) => hasAvailableNodes(p, snap)).length;
  const maint = pools.every(isMaintPool);
  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 border-b border-border pb-1.5">
        <span className={cn("h-2.5 w-2.5 rounded-full", maint ? "bg-muted-foreground/45" : available > 0 ? "bg-ok" : "bg-bad")} />
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
        <span className="font-mono text-xs text-muted-foreground">
          {available}/{pools.length} {t("part.available")}
        </span>
      </div>
      <div className={cn("grid gap-4", pools.length > 1 && "lg:grid-cols-2")}>
        {pools.map((p) => (
          <PoolCard key={p.id} pool={p} snap={snap} t={t} />
        ))}
      </div>
    </section>
  );
}

function PoolCard({ pool, snap, t }: { pool: Pool; snap: Snapshot; t: TFn }) {
  const [open, setOpen] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  const isGpu = pool.kind === "gpu";
  const maint = isMaintPool(pool);
  const availableNodes = pool.available_nodes ?? pool.idle_nodes ?? 0;
  const samplePartition = SAMPLE[pool.id]?.partition ?? "";
  const gpuFit = isGpu ? gpuFitSnapshot(snap, pool, partitionCap(samplePartition, snap.policy), samplePartition) : null;
  const gpuSched = gpuFit?.schedulable ?? 0;
  const pendingActive = isGpu ? contendersForPool(snap, pool.id) : [];
  // A schedulable slot only means "starts now" if no queued job can claim it
  // first — judged for the interactive default (GPU salloc is pinned to 12h).
  const gpuClear = !isGpu || !gpuFit || gpuSched <= 0
    || fitHasClearSlot(gpuFit, pendingActive, Date.now(), 720 * 60);
  const rawGpuFree = isGpu ? pool.gpu?.free ?? 0 : 0;
  const displayFree = isGpu ? rawGpuFree : pool.cores.free;
  const hasAvailable = (isGpu ? gpuSched > 0 && gpuClear : availableNodes > 0) && !maint;
  const hasStrandedGpu = isGpu && rawGpuFree > 0 && !(gpuSched > 0 && gpuClear) && !maint;
  const availableNodesLabel = isGpu
    ? t("pool.gpuFreePhysical", { n: rawGpuFree })
    : t("pool.availableNodes", { n: availableNodes });
  const free = displayFree;
  const total = isGpu && pool.gpu ? pool.gpu.total : pool.cores.total;
  const used = isGpu && pool.gpu ? pool.gpu.used : pool.cores.alloc;
  const util = total ? used / total : 0;   // bar fills as the pool gets used (full = red)
  const freeRatio = total ? free / total : 0;
  // colour by how much is free: none = red, scarce (<10%) = amber, plenty = green
  const freeColor = maint
    ? "text-muted-foreground"
    : hasStrandedGpu
      ? "text-warn-fg"
    : free === 0
      ? "text-bad-fg"
      : freeRatio < 0.1
        ? "text-warn-fg"
        : "text-ok-fg";

  return (
    <Card
      className={cn(
        "transition-colors",
        maint
          ? "border-dashed border-muted-foreground/30 opacity-60"
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
            <span className="font-semibold">{poolLabel(t, pool.id)}</span>
            <span className="text-xs text-muted-foreground">
              {pool.nodes} {t("spec.nodes")} · {fmtMB(pool.mem_per_node)}
            </span>
          </div>
          <span className="tnum font-mono text-sm text-muted-foreground">
            {maint ? t("pool.maint") : availableNodesLabel}
          </span>
        </div>

        <div className="mt-3 flex items-end justify-between gap-3">
          <div>
            {maint ? (
              <span className="text-lg font-semibold text-muted-foreground">{t("pool.maint")}</span>
            ) : (
              <div className={cn("tnum text-2xl font-bold", freeColor)}>
                {isGpu ? (
                  t("pool.gpuCount", { n: nf(free) })
                ) : (
                  <>
                    {nf(free)}
                    <span className="text-sm font-normal text-muted-foreground">
                      {" / "}
                      {nf(total)} {t("unit.cores")}
                    </span>
                  </>
                )}
              </div>
            )}
            <div className="text-xs text-muted-foreground">
              {maint ? null : gpuAvailabilityText(isGpu, gpuFit, gpuSched, rawGpuFree, availableNodesLabel, pendingActive, t)}
            </div>
          </div>
          <ReleaseHint pool={pool} generatedAt={snap.generated_at} />
        </div>

        {isGpu && pool.gpu ? (
          <GpuBlocks gpu={pool.gpu} schedulableFree={gpuSched} className="mt-2" />
        ) : (
          <Bar value={maint ? 0 : util} tone={maint ? "neutral" : undefined} className="mt-2" />
        )}

        <div className="mt-2.5 flex flex-wrap items-center gap-x-4 text-xs text-muted-foreground">
          <span>
            <b className="text-ok-fg">{pool.queue.running}</b> {t("queue.running")}
          </span>
          <span>
            <b className={pool.queue.pending ? "text-warn-fg" : "text-foreground"}>{pool.queue.pending}</b>{" "}
            {t("queue.pending")}
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
      className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
    >
      <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 transition-transform", open && "rotate-90")} />
      <span className="font-medium text-foreground/85">{label}</span>
      {count !== undefined && <span className="tnum font-mono">{count}</span>}
      {summary && <span className="ml-auto flex min-w-0 items-center gap-1.5 pl-2">{summary}</span>}
    </button>
  );
}

function ReleaseHint({ pool, generatedAt }: { pool: Pool; generatedAt: number }) {
  const next = pool.kind === "gpu" ? pool.gpu?.next_free : null;
  const releasingNodes = pool.queue.releasing.nodes;
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    if (!next) return;
    setNow(Date.now() / 1000);
    const id = setInterval(() => setNow(Date.now() / 1000), 30_000);
    return () => clearInterval(id);
  }, [next, generatedAt]);

  if (!next && releasingNodes <= 0) return null;
  const remaining = next ? Math.max(0, parseDur(next.left) - (now - generatedAt)) : 0;
  return (
    <div className="flex flex-col items-end gap-1 text-right text-xs">
      {next && (
        <span className="text-info-fg">
          ~ {clockOf(next.at)} <span className="text-muted-foreground">({fmtDur(remaining)})</span>
        </span>
      )}
      {releasingNodes > 0 && <Tag tone="info">↑{releasingNodes}</Tag>}
    </div>
  );
}

/** Collapsible, editable starter request for this pool. Collapsed by default;
 *  starts from the selected policy and lets Slurm apply partition defaults. */
function RequestSample({ pool, t }: { pool: Pool; t: TFn }) {
  const { snap } = useLive();
  const base = SAMPLE[pool.id];
  const [open, setOpen] = useState(false);
  const [partChoice, setPartChoice] = useState("");
  // pty: interactive intent delivered through a batch placeholder — the only
  // way to get a shell with a short (backfillable) walltime on GPU partitions
  const [mode, setMode] = useState<"interactive" | "script" | "pty">("interactive");
  const [scriptFile, setScriptFile] = useState("job.sh");
  const [advanced, setAdvanced] = useState(false);
  const [nodes, setNodes] = useState("");
  const [cores, setCores] = useState("");
  const [mem, setMem] = useState("");
  const [time, setTime] = useState("");
  if (!base) return null;

  const isGpu = pool.kind === "gpu";
  const partition = pool.partitions.includes(partChoice) ? partChoice : base.partition;
  const cap = partitionCap(partition, snap?.policy);
  const policy = partitionPolicy(partition, snap?.policy);
  const selectedPart = snap?.partitions.find((p) => p.name === partition);
  const groupRunning = snap ? partitionRunningJobs(snap.jobs, partition) : 0;
  const gpuFit = snap && isGpu ? gpuFitSnapshot(snap, pool, cap, partition) : null;
  const memRaw = mem.trim();
  const normalizedMem = normalizeMem(memRaw);
  const parsedMemMb = normalizedMem ? parseMemoryInputMb(normalizedMem) : 0;
  const maxMemMb = cap.maxMemGb ? cap.maxMemGb * 1024 : 0;
  const memTooHigh = parsedMemMb > 0 && maxMemMb > 0 && parsedMemMb > maxMemMb;
  const memValue = normalizedMem && !memTooHigh ? normalizedMem : "";
  const memError = memRaw && !normalizedMem
    ? t("pool.memInvalid")
    : memTooHigh
      ? t("pool.memTooHigh", { max: `${cap.maxMemGb}G` })
      : "";
  const memOverrideMb = memValue ? parsedMemMb : 0;
  const effectiveGpuFit = gpuFit && memOverrideMb > 0 ? gpuFitWithMemOverride(gpuFit, memOverrideMb) : gpuFit;
  const pendingActive = snap && isGpu ? contendersForPool(snap, pool.id) : [];
  const queueFact = snap ? poolQueueFact(snap.jobs, snap.part_pool, pool.id, isGpu, pool, effectiveGpuFit?.schedulable ?? 0) : null;
  const limits = policyLimitRows(policy, groupRunning, t);
  const groupLimitReached = Boolean(policy.grpJobs && groupRunning >= policy.grpJobs);
  const nodeCount = clampPositiveInt(nodes, cap.maxNodes);
  const coreCount = clampPositiveInt(cores, cap.maxCores);
  const cpuRows = snap && !isGpu && pool.id === "cpu" ? cpuProbeRows(pool, snap) : [];
  const cpuProbeGeneratedAt = snap?.cpu_submit_probes_generated_at || snap?.generated_at || 0;
  const hasAdvancedOverrides = Boolean(nodeCount || coreCount || memValue || time.trim());
  const selectedCpuRow = !hasAdvancedOverrides ? cpuRows.find((row) => row.partition === partition) ?? null : null;
  // salloc can't take the -t deal (plugin forces the walltime); the displayed
  // command's effective walltime decides what a tip may promise.
  const forcedSec = mode === "interactive" ? interactiveForcedSec(partition, isGpu) : null;
  // pty defaults to the 12h an interactive session would have had — pick a
  // shorter -t to slip into a gap
  const ptyTime = time.trim() || "12:00:00";
  const requestSec = forcedSec
    ?? (parseWalltimeSec(mode === "pty" ? ptyTime : time) || Number.POSITIVE_INFINITY);
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
  // when the gap already holds the forced 12h, reduce to the --mem part.
  // mem-less + gap ≥ 12h needs no tip — the verdict flips to "can start".
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
  // Partition options carry their verdict so the dropdown reads like tabs:
  // "GPU-S · 可绕过" beats opening each one to find out. CPU pools already
  // label options with their probe result; in interactive mode each option
  // is judged with its own plugin-forced walltime.
  const optionVerdictSec = mode === "interactive" ? undefined : (parseWalltimeSec(time) || Number.POSITIVE_INFINITY);
  const optionLabel = (p: string): string => {
    if (cpuRows.length > 0) return cpuOptionLabel(p, cpuRows, cpuProbeGeneratedAt, t);
    const base = isMaterialsStudioPartition(p) ? `${p} · ${trMaybe(t, `policy.${p}`, p)}` : p;
    if (!snap) return base;
    const s = partitionRequestSummary(pool, snap, p, isGpu, pendingActive, nowMs, t, optionVerdictSec);
    if (!s) return base;
    const verdict = s.hint?.tone === "ok"
      ? t("pool.queueHintCanStart")
      : s.gpuTip
        ? t("pool.optBypass")
        : s.bfTip
          ? t("pool.optGap")
          : s.hint
            ? t("pool.queueHintWillQueue")
            : "";
    return verdict ? `${base} · ${verdict}` : base;
  };
  const queueHint = selectedCpuRow
    ? null
    : requestQueueHint({
        part: selectedPart,
        policy,
        groupRunning,
        nodeCount,
        coreCount,
        isGpu,
        poolFree: snap ? poolCapacity(snap, pool.id) : null,
        queueFact,
        gpuFit: effectiveGpuFit,
        pendingActive,
        // the plugin-forced walltime, not the -t field, is what Slurm sees
        userTimeSec: forcedSec ?? parseWalltimeSec(mode === "pty" ? ptyTime : time),
        t,
      });
  const flags = [`-p ${partition}`, ...(base.requiredFlags ?? [])];
  if (nodeCount) flags.push(`-N ${nodeCount}`);
  if (coreCount) flags.push(`-c ${coreCount}`);
  if (memValue) flags.push(`--mem=${memValue}`);
  // a -t on a forced-walltime salloc is silently ignored — don't emit one
  if (mode !== "pty" && time.trim() && forcedSec === null) flags.push(`-t ${time.trim()}`);
  const script = scriptFile.trim() || "job.sh";
  const cmd = mode === "interactive"
    ? `salloc ${flags.join(" ")}`
    : mode === "script"
      ? `sbatch ${flags.join(" ")} ${script}`
      // paste all three lines: when the shell exits, scancel frees the
      // placeholder automatically — no idling to the time limit
      : [
          `JOB=$(sbatch --parsable ${[...flags, `-t ${ptyTime}`].join(" ")} --wrap 'sleep infinity')`,
          "srun --jobid $JOB --overlap --pty bash",
          "scancel $JOB",
        ].join("\n");
  const policyName = trMaybe(t, `policy.${partition}`, partition);
  const policyDesc = trMaybe(t, `policy.${partition}.desc`, "");
  const limitText = fmtPolicyLimit(cap, isGpu, t);
  const policyLimit = limitText ? `${t("part.policyLimit")} ${limitText}` : "";
  const multiNodeCpuPolicy = !isGpu && (cap.maxNodes ?? 1) > 1;
  const nodeOptions = numberOptions(cap.maxNodes, [1, 2, 3, 4, 8, 16, 32]);
  const coreOptions = numberOptions(cap.maxCores, [1, 2, 4, 8, 16, 26, 32, 52, 64, 96, 128, 208, 256, 512, 768, 1024, 2048, 4096, 8192]);
  const timeOptions = timeOptionsFor(cap.wall, t);
  const partitionGroups = partitionOptionGroups(pool.partitions, t);
  const fieldCls = "h-7 w-full rounded-md border border-border bg-background px-2 text-xs outline-none focus:border-primary";

  // Collapsed one-glance verdict for the row. Scan every partition and lead
  // with the most startable one — the default partition's "will queue · group
  // full" must not hide that a sibling policy can start (possibly via a tip).
  const collapsedPick = !open && snap
    ? bestPartitionPick(pool, snap, isGpu, pendingActive, cpuRows, cpuProbeGeneratedAt, t)
    : null;
  const rowSummary = collapsedPick ? (
    <>
      <Tag tone={collapsedPick.tone}>{collapsedPick.label}</Tag>
      {collapsedPick.text && (
        <span className="min-w-0 truncate text-xs text-muted-foreground">{collapsedPick.text}</span>
      )}
    </>
  ) : null;

  return (
    <>
      <DisclosureRow open={open} onToggle={() => setOpen(!open)} label={t("pool.quickRequest")} summary={rowSummary} />
      {open && (
        <div className="space-y-2 px-2 pb-2 pt-0.5">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {pool.partitions.length > 1 && (
              <Field label={t("col.partition")}>
                <select value={partition} onChange={(e) => setPartChoice(e.target.value)} className={fieldCls}>
                  {partitionGroups.map((group) => (
                    group.label ? (
                      <optgroup key={group.key} label={group.label}>
                        {group.items.map((p) => (
                          <option key={p} value={p}>{optionLabel(p)}</option>
                        ))}
                      </optgroup>
                    ) : (
                      <Fragment key={group.key}>
                        {group.items.map((p) => (
                          <option key={p} value={p}>{optionLabel(p)}</option>
                        ))}
                      </Fragment>
                    )
                  ))}
                </select>
              </Field>
            )}
            <Field label={t("pool.mode")}>
              <div className="flex h-7 rounded-md border border-border p-0.5">
                {((isGpu ? ["interactive", "pty", "script"] : ["interactive", "script"]) as ("interactive" | "pty" | "script")[]).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setMode(m)}
                    className={cn(
                      "flex-1 rounded-[4px] px-2 text-xs transition-colors",
                      mode === m ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {t(m === "interactive" ? "pool.modeInteractive" : m === "pty" ? "pool.modePty" : "pool.modeScript")}
                  </button>
                ))}
              </div>
            </Field>
            {mode === "script" && (
              <Field label={t("pool.scriptFile")}>
                <input value={scriptFile} onChange={(e) => setScriptFile(e.target.value)} className={fieldCls} />
              </Field>
            )}
          </div>
          {/* terminal-styled on purpose (dark in both themes + $ prompt): with no
              caption around it, the surface itself has to say "run this in a shell" */}
          <div className="flex items-start gap-2 rounded-md border border-zinc-800 bg-zinc-950 px-2.5 py-1.5">
            <span aria-hidden className="select-none font-mono text-xs text-zinc-500">$</span>
            <code className={cn("flex-1 overflow-x-auto font-mono text-xs text-zinc-100", mode === "pty" ? "whitespace-pre" : "whitespace-nowrap")}>{cmd}</code>
            <CopyButton text={cmd} label className="text-zinc-400 hover:bg-white/10 hover:text-zinc-100" />
          </div>
          {/* one-line pointer here, full recipe in the guide */}
          {isGpu && mode !== "interactive" && (
            <div className="text-xs leading-relaxed text-muted-foreground">
              {mode === "script" ? t("pool.scriptPtyHint") : t("pool.ptyNote", { t: ptyTime })}{" "}
              <Link to="/slurm#pty" className="whitespace-nowrap text-info-fg hover:underline">
                {t("pool.scriptPtyMore")}
              </Link>
            </div>
          )}

          {/* why / limits — explanation reads after the deliverable, not before it */}
          <div className="rounded-md border border-border bg-muted/30 px-2.5 py-2">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-xs font-medium text-foreground">{policyName}</span>
              {queueHint && (!showGpuFitDetails || groupLimitReached || !gpuTip) && (
                <Tag tone={queueHint.tone}>{queueHint.label}</Tag>
              )}
              {policyLimit && <span className="font-mono text-xs text-muted-foreground">{policyLimit}</span>}
            </div>
            {policyDesc && <div className="mt-1 text-xs leading-relaxed text-muted-foreground">{policyDesc}</div>}
            {queueHint?.detail && (!showGpuFitDetails || groupLimitReached || !gpuTip) && (
              <div className="mt-1 text-xs leading-relaxed text-muted-foreground">{queueHint.detail}</div>
            )}
            {selectedCpuRow && <CpuProbeInline row={selectedCpuRow} generatedAt={cpuProbeGeneratedAt} t={t} />}
            {hasAdvancedOverrides && cpuRows.length > 0 && (
              <div className="mt-1 text-xs leading-relaxed text-muted-foreground">{t("pool.cpuProbeDefaultOnly")}</div>
            )}
            {multiNodeCpuPolicy && <div className="mt-1 text-xs leading-relaxed text-warn-fg">{t("pool.multiNodeHint")}</div>}
            {gpuTip && (
              <GpuFitQuickTip
                tip={gpuTip}
                applied={memValue === gpuTip.mem}
                onApply={() => {
                  setMem(gpuTip.mem);
                  setAdvanced(true);
                }}
                t={t}
              />
            )}
            {bfTip && bfVariant && (
              <GpuBackfillQuickTip
                tip={bfTip}
                variant={bfVariant}
                applied={
                  bfVariant === "fits"
                    ? memValue === bfTip.mem
                    : bfVariant === "switch"
                      // still in interactive mode — the advice (switch to
                      // script) hasn't been taken even if -t/--mem match
                      ? false
                      : time === bfTip.t && (!bfTip.mem || memValue === bfTip.mem)
                }
                onApply={() => {
                  if (bfTip.mem) setMem(bfTip.mem);
                  if (bfVariant !== "fits") {
                    setTime(bfTip.t);
                    // the user wanted interactive — hand them the pty recipe,
                    // not a batch script
                    if (bfVariant === "switch") setMode("pty");
                  }
                  setAdvanced(true);
                }}
                t={t}
              />
            )}
            {/* diagnostic detail below the fix-it row: when applying the tip makes
                this block disappear, nothing above the clicked button moves */}
            {showGpuFitDetails && gpuFit && <GpuFitExplanation fit={gpuFit} pendingActive={pendingActive} t={t} />}
            <PolicyLimitChips rows={limits} />
            {groupLimitReached && <div className="mt-1 text-xs leading-relaxed text-bad-fg">{t("pool.limitReached")}</div>}
          </div>

          {/* last on purpose: it only grows downward, so toggling it (or the
              mem-tip auto-open) never shifts the command or the tip button */}
          <button
            type="button"
            onClick={() => setAdvanced(!advanced)}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ChevronRight className={cn("h-3 w-3 transition-transform", advanced && "rotate-90")} />
            {t("pool.advanced")}
          </button>
          {advanced && (
            <div className="space-y-1.5">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                <Field label={capSuffix(t("spec.nodes"), cap.maxNodes)}>
                  <select value={nodes} onChange={(e) => setNodes(e.target.value)} className={fieldCls}>
                    <option value="">{t("pool.default")}</option>
                    {nodeOptions.map((n) => (
                      <option key={n} value={String(n)}>{n}</option>
                    ))}
                  </select>
                </Field>
                <Field label={capSuffix(t("unit.cores"), cap.maxCores)}>
                  <select value={cores} onChange={(e) => setCores(e.target.value)} className={fieldCls}>
                    <option value="">{t("pool.default")}</option>
                    {coreOptions.map((n) => (
                      <option key={n} value={String(n)}>{n}</option>
                    ))}
                  </select>
                </Field>
                <Field label={`${t("kpi.memory")} (--mem)`}>
                  <input
                    value={mem}
                    onChange={(e) => setMem(e.target.value)}
                    placeholder={gpuTip?.mem || t("pool.default")}
                    className={cn(fieldCls, memError && "border-bad")}
                  />
                  {memError && <span className="mt-0.5 block text-xs leading-tight text-bad-fg">{memError}</span>}
                </Field>
                <Field label={t("pool.time")}>
                  {forcedSec !== null ? (
                    // the plugin pins interactive walltime; a select would lie
                    <div className={cn(fieldCls, "flex items-center truncate text-muted-foreground")}>
                      {t("pool.timeForcedInteractive", { t: forcedSec === 720 * 60 ? "12h" : "2d" })}
                    </div>
                  ) : (
                    <select value={time} onChange={(e) => setTime(e.target.value)} className={fieldCls}>
                      {/* backfill-tip suggestions aren't in the canonical list */}
                      {time && !timeOptions.some((opt) => opt.value === time) && (
                        <option value={time}>{time}</option>
                      )}
                      {timeOptions.map((opt) => (
                        <option key={opt.value || "default"} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                  )}
                </Field>
              </div>
              <div className="text-xs leading-relaxed text-muted-foreground">{t("pool.nodeRequestHint")}</div>
            </div>
          )}
        </div>
      )}
    </>
  );
}

function clampPositiveInt(value: string, max?: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  const n = Math.floor(parsed);
  return max ? Math.min(n, max) : n;
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

function capSuffix(label: string, max?: number) {
  return max ? `${label} <=${max}` : label;
}

function numberOptions(max: number | undefined, values: number[]) {
  const limit = max ?? Math.max(...values);
  const out = new Set(values.filter((n) => n > 0 && n <= limit));
  if (max && max > 0) out.add(max);
  return [...out].sort((a, b) => a - b);
}

function timeOptionsFor(wall: string | undefined, t: TFn) {
  const limit = parseWallMinutes(wall);
  const base = [
    { value: "00:30:00", label: "30m", minutes: 30 },
    { value: "01:00:00", label: "1h", minutes: 60 },
    { value: "02:00:00", label: "2h", minutes: 120 },
    { value: "06:00:00", label: "6h", minutes: 360 },
    { value: "12:00:00", label: "12h", minutes: 720 },
    { value: "1-00:00:00", label: "1d", minutes: 1440 },
    { value: "2-00:00:00", label: "2d", minutes: 2880 },
    { value: "3-00:00:00", label: "3d", minutes: 4320 },
    { value: "5-00:00:00", label: "5d", minutes: 7200 },
    { value: "7-00:00:00", label: "7d", minutes: 10080 },
    { value: "14-00:00:00", label: "14d", minutes: 20160 },
    { value: "21-00:00:00", label: "21d", minutes: 30240 },
  ];
  return [
    { value: "", label: t("pool.timeDefault") },
    ...base.filter((opt) => !limit || opt.minutes <= limit),
  ];
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
  if (!isGpu && coreCount > 0 && poolFree && coreCount > poolFree.emptiestNodeFree) return warn(t("pool.queueReasonCores"));

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
  cpuProbeGeneratedAt: number,
  t: TFn,
): CollapsedPick | null {
  const multi = pool.partitions.length > 1;
  const prefix = (p: string, text: string) => (multi ? (text ? `${p} · ${text}` : p) : text);
  // CPU pool: sbatch --test-only probes already hold a per-partition verdict.
  if (!isGpu && cpuRows.length > 0) {
    const rank = (row: CpuProbeRow) => {
      const s = cpuProbeState(row.probe, cpuProbeGeneratedAt);
      return s === "now" ? 0 : s === "queued" ? 2 : 3;
    };
    const best = [...cpuRows].sort((a, b) => rank(a) - rank(b))[0];
    const state = cpuProbeState(best.probe, cpuProbeGeneratedAt);
    return { tone: cpuProbeTone(state), label: cpuProbeLabel(state, t), text: `-p ${best.partition}` };
  }
  const nowMs = Date.now();
  const summaries = pool.partitions
    .filter((p) => !isMaterialsStudioPartition(p))
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
  const cap = partitionCap(partition, snap.policy);
  const policy = partitionPolicy(partition, snap.policy);
  const groupRunning = partitionRunningJobs(snap.jobs, partition);
  const groupLimitReached = Boolean(policy.grpJobs && groupRunning >= policy.grpJobs);
  const gpuFit = isGpu ? gpuFitSnapshot(snap, pool, cap, partition) : null;
  // default: preview the interactive command with its plugin-forced walltime
  const requestSec = requestSecOverride ?? interactiveForcedSec(partition, isGpu) ?? Number.POSITIVE_INFINITY;
  const gpuTip = isGpu && gpuFit && gpuFit.schedulable <= 0 && !groupLimitReached
    ? gpuFitTipCommand(gpuFit, pool, pendingActive, nowMs, requestSec)
    : null;
  const bfTip = isGpu && gpuFit && !gpuTip && !groupLimitReached
    ? gpuBackfillTipCommand(gpuFit, pool, pendingActive, nowMs, requestSec)
    : null;
  const queueFact = poolQueueFact(snap.jobs, snap.part_pool, pool.id, isGpu, pool, gpuFit?.schedulable ?? 0);
  const hint = requestQueueHint({
    part,
    policy,
    groupRunning,
    nodeCount: 0,
    coreCount: 0,
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

function queueFactText(fact: QueueFact, t: TFn) {
  const free = fact.isGpu
    ? t("pool.queueFactFreeGpu", { n: fact.free })
    : t("pool.queueFactFreeCpu", { n: fact.free });
  const largest = fact.maxGpus > 0
    ? t("pool.queueFactMaxGpu", { n: fact.maxGpus })
    : t("pool.queueFactMaxCpu", { n: fact.maxCpus });
  const priority = fact.priority > 0 ? ` · ${t("pool.queueFactPriority", { n: fact.priority })}` : "";
  const limited = fact.limited > 0 ? ` · ${t("pool.queueFactLimited", { n: fact.limited })}` : "";
  return `${free} · ${t("pool.queueFactPool", { n: fact.pending })}${priority}${limited} · ${largest}`;
}

function partitionRunningJobs(jobs: RawJob[], partition: string) {
  let groupRunning = 0;
  for (const job of jobs) {
    const parts = String(job.partition || "").split(",");
    if (!parts.includes(partition)) continue;
    const state = String(job.job_state || "").toUpperCase();
    if (state === "RUNNING") groupRunning += 1;
  }
  return groupRunning;
}

function GpuFitQuickTip({
  tip,
  applied,
  onApply,
  t,
}: {
  tip: GpuFitTipData;
  applied: boolean;
  onApply: () => void;
  t: TFn;
}) {
  return (
    <div className="mt-2 rounded-md border border-warn/40 bg-warn-soft/45 px-2 py-1.5 text-xs leading-relaxed">
      <div className="flex flex-wrap items-center gap-1.5">
        <Tag tone="warn">{t("pool.fitTip")}</Tag>
        <span className="text-foreground">{t("pool.fitTipText", { mem: tip.mem, node: tip.node })}</span>
        <button
          type="button"
          onClick={onApply}
          className={cn(
            "rounded border px-1.5 py-0.5 font-medium transition-colors",
            applied
              ? "border-ok/40 bg-ok-soft text-ok-fg"
              : "border-warn/45 bg-background/80 text-warn-fg hover:bg-warn-soft",
          )}
        >
          {t(applied ? "pool.fitTipApplied" : "pool.fitTipApply", { mem: tip.mem })}
        </button>
      </div>
    </div>
  );
}

function GpuBackfillQuickTip({
  tip,
  variant,
  applied,
  onApply,
  t,
}: {
  tip: GpuBackfillTipData;
  /** script: normal -t advice · switch: salloc can't -t, offer script mode · fits: gap ≥ forced 12h, only --mem needed */
  variant: "script" | "switch" | "fits";
  applied: boolean;
  onApply: () => void;
  t: TFn;
}) {
  const until = clockShort(tip.untilMs);
  const text =
    variant === "switch"
      ? tip.mem
        ? t("pool.bfTipSalloc", { node: tip.node, until, mem: tip.mem, t: tip.t })
        : t("pool.bfTipSallocTime", { node: tip.node, until, t: tip.t })
      : variant === "fits"
        ? t("pool.bfTipFits", { node: tip.node, until, mem: tip.mem })
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

function partitionOptionGroups(partitions: string[], t: TFn) {
  const general = partitions.filter((partition) => !isMaterialsStudioPartition(partition));
  const materials = partitions.filter(isMaterialsStudioPartition);
  const groups: Array<{ key: string; label: string; items: string[] }> = [];
  if (general.length > 0) {
    groups.push({
      key: "general",
      label: materials.length > 0 ? t("part.generalCpuPolicies") : "",
      items: general,
    });
  }
  if (materials.length > 0) {
    groups.push({ key: "materials-studio", label: t("part.materialsStudioGroup"), items: materials });
  }
  return groups;
}

function cpuOptionLabel(partition: string, rows: CpuProbeRow[], generatedAt: number, t: TFn) {
  const row = rows.find((item) => item.partition === partition);
  const base = isMaterialsStudioPartition(partition)
    ? `${partition} · ${trMaybe(t, `policy.${partition}`, partition)}`
    : partition;
  if (!row) return base;
  return `${base} · ${cpuProbeLabel(cpuProbeState(row.probe, generatedAt), t)}`;
}

function CpuProbeInline({ row, generatedAt, t }: { row: CpuProbeRow; generatedAt: number; t: TFn }) {
  const state = cpuProbeState(row.probe, generatedAt);
  const detail = cpuProbeDetail(row, state, t);
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
      <Tag tone={cpuProbeTone(state)}>{cpuProbeLabel(state, t)}</Tag>
      {row.cores > 0 && (
        <span className="font-mono text-muted-foreground">{t("pool.cpuProbeNeed", { cores: row.cores })}</span>
      )}
      {detail && <span className="min-w-0 truncate text-muted-foreground">{detail}</span>}
      <span className="font-mono text-info-fg">{row.command}</span>
    </div>
  );
}

function trMaybe(t: TFn, key: string, fallback: string) {
  const translated = t(key as TranslationKey);
  return translated === key ? fallback : translated;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="min-w-0 text-xs text-muted-foreground">
      <span className="mb-0.5 block truncate">{label}</span>
      {children}
    </label>
  );
}

// The pool card previews the interactive default, which GPU salloc pins to
// 12h — a slot (or its reservation gap) must hold that much to claim "free".
const CARD_REQUEST_SEC = 720 * 60;

function gpuAvailabilityText(isGpu: boolean, fit: GpuFitInfo | null, schedulable: number, rawFree: number, availableLabel: string, pendingActive: RawJob[], t: TFn) {
  if (!isGpu) return availableLabel;
  if (schedulable > 0) {
    if (fit && !fitHasClearSlot(fit, pendingActive, Date.now(), CARD_REQUEST_SEC)) {
      return t("pool.gpuStrandedContested", { n: rawFree });
    }
    return availableLabel;
  }
  if (rawFree > 0) return gpuStrandedText(fit, rawFree, pendingActive, t);
  return t("gpu.full");
}

function gpuStrandedText(fit: GpuFitInfo | null, rawFree: number, pendingActive: RawJob[], t: TFn) {
  const rows = fit?.stranded ?? [];
  const mem = rows.some((row) => row.missingMemMb > 0);
  const cpu = rows.some((row) => row.missingCores > 0);
  if (cpu && mem) return t("pool.gpuStrandedCpuMem", { n: rawFree });
  if (cpu) return t("pool.gpuStrandedCpu", { n: rawFree });
  if (mem) {
    const best = strandedTipNode(fit);
    // Only queued jobs that can start HERE and NOW own the slot; a reservation
    // whose idle gap still holds a 12h job does not (verified live: a test
    // job started instantly on a PLANNED node while the card said "reserved").
    if (best && slotBlocked(slotContention(best, pendingActive, Date.now()), CARD_REQUEST_SEC)) {
      return t("pool.gpuStrandedContested", { n: rawFree });
    }
    const tip = best ? `${conservativeMemGb(best.freeMemMb)}G` : "";
    return best && conservativeMemGb(best.freeMemMb) > 0
      ? t("pool.gpuStrandedMemTip", { n: rawFree, mem: tip })
      : t("pool.gpuStrandedMem", { n: rawFree });
  }
  return t("pool.gpuStranded", { n: rawFree });
}

function strandedTipNode(fit: GpuFitInfo | null) {
  return fit?.stranded.find((row) => row.freeGpu >= 1 && row.freeCores >= fit.need.cores && row.freeMemMb > 1024) ?? null;
}

function GpuFitExplanation({ fit, pendingActive, t }: { fit: GpuFitInfo; pendingActive: RawJob[]; t: TFn }) {
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
      {contention && slotBlocked(contention, CARD_REQUEST_SEC) && (
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
  if (job.cpus) parts.push(`${nf(job.cpus)} ${t("unit.cores")}`);
  if (job.min_memory) parts.push(job.min_memory);
  return parts.length ? `(${parts.join(" / ")})` : "";
}

function missingText(row: GpuFitNode, t: TFn) {
  const parts = [];
  if (row.missingGpu > 0) parts.push(`${nf(row.missingGpu)} ${t("unit.gpu")}`);
  if (row.missingCores > 0) parts.push(`${nf(row.missingCores)} ${t("unit.cores")}`);
  if (row.missingMemMb > 0) parts.push(`${fmtMemRaw(row.missingMemMb)} ${t("kpi.memory")}`);
  return parts.length ? parts.join(" / ") : "0";
}

function fmtMemRaw(mb: number) {
  return `${nf(Math.max(0, Math.round(mb)))}M`;
}

/** One block per physical GPU — free (green) first, then used (red), then down (grey). */
function GpuBlocks({ gpu, schedulableFree, className }: { gpu: PoolGpu; schedulableFree?: number; className?: string }) {
  const ready = Math.max(0, Math.min(gpu.free, schedulableFree ?? gpu.free));
  const stranded = Math.max(0, gpu.free - ready);
  const seg = (n: number, cls: string, key: string) =>
    Array.from({ length: Math.max(0, n) }, (_, i) => (
      <span key={key + i} className={cn("h-2.5 min-w-0 flex-1 rounded-sm", cls)} />
    ));
  return (
    <div className={cn("flex gap-0.5", className)} title={`${ready} schedulable · ${stranded} stranded · ${gpu.used} used${gpu.down ? ` · ${gpu.down} down` : ""}`}>
      {seg(ready, "bg-ok", "f")}
      {seg(stranded, "bg-warn", "s")}
      {seg(gpu.used, "bg-bad", "u")}
      {seg(gpu.down, "bg-muted-foreground/40", "d")}
    </div>
  );
}

function isMaintPool(pool: Pool) {
  return pool.kind === "gpu" && !!pool.gpu?.maint;
}

function hasAvailableNodes(pool: Pool, snap: Snapshot) {
  if (isMaintPool(pool)) return false;
  if (pool.kind === "gpu") return schedulableGpuSlots(snap.nodes, pool, partitionCap(SAMPLE[pool.id]?.partition ?? "", snap.policy)) > 0;
  return (pool.available_nodes ?? pool.idle_nodes ?? 0) > 0;
}

function PendingJobs({ pool, t }: { pool: Pool; t: TFn }) {
  const { snap } = useLive();
  if (!snap) return null;
  const all = pendingForPool(snap.jobs, snap.part_pool, pool.id)
    .map((job, i) => ({ job, i }))
    .sort((a, b) => pendingRank(a.job) - pendingRank(b.job) || a.i - b.i)
    .map(({ job }) => job);
  const list = all.slice(0, 12);
  if (list.length === 0) return null;
  return (
    <div className="mt-2 max-h-64 space-y-1 overflow-y-auto pr-1">
      <div className="pb-1 text-xs text-muted-foreground">{t("pool.pendingShowing", { shown: list.length, total: all.length })}</div>
      {list.map((j) => (
        <PendingJobRow key={String(j.job_id)} job={j} t={t} />
      ))}
    </div>
  );
}

function PendingJobRow({ job, t }: { job: RawJob; t: TFn }) {
  const rawReason = job.state_reason || "None";
  const reason = reasonLabel(t, rawReason);
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
        {reason}
        {reason !== rawReason && <span className="font-mono"> ({rawReason})</span>}
      </div>
    </div>
  );
}

function pendingJobResources(job: RawJob, t: TFn) {
  const parts = [];
  if (job.gpus > 0) parts.push(`${job.gpus} ${t("unit.gpu")}`);
  if (job.cpus > 0) parts.push(`${job.cpus}c`);
  if ((job.min_memory_mb ?? 0) > 0) parts.push(fmtMB(job.min_memory_mb));
  if (job.node_count > 0) parts.push(`${job.node_count} ${t("spec.nodes")}`);
  return parts.join(" · ") || "—";
}

function pendingRank(job: RawJob) {
  return isLimitBlocked(job) ? 1 : 0;
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
      {pool.partitions.length > 0 && (
        <div className="pt-2 text-xs text-muted-foreground">
          {t("pool.submit")}: <span className="font-mono">{pool.partitions.join(", ")}</span>
        </div>
      )}
    </div>
  );
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
  const primary = isGpu ? `${group.gpus} ${t("unit.gpu")}` : `${group.cpus}c`;
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
          {isGpu && <> · {group.cpus}c</>} · {fmtMB(group.mem_mb)}
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
  if (o.cpus > 0) parts.push(`${o.cpus}c`);
  if (o.mem_mb > 0) parts.push(fmtMB(o.mem_mb));
  return parts.join(" · ") || "—";
}
