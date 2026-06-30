import { Fragment, useEffect, useState, type ReactNode } from "react";
import { Check, ChevronRight, Copy } from "lucide-react";
import { Bar } from "@/components/common/bar";
import { Tag } from "@/components/common/tag";
import { Card, CardContent } from "@/components/ui/card";
import { useLive } from "@/hooks/use-live";
import { useResourceFilter } from "@/hooks/use-resource-filter";
import { poolLabel, reasonLabel, useT, type TFn, type TranslationKey } from "@/i18n";
import { copyText } from "@/lib/clipboard";
import { expandHostlist, occupantsForPool, poolCapacity } from "@/lib/derive";
import { clockOf, fmtCountdown, fmtDur, fmtMB, nf, parseDur } from "@/lib/format";
import { isMaterialsStudioPartition, matchPool, partitionCap, partitionPolicy, type PartitionPolicy } from "@/lib/slurm";
import { cn } from "@/lib/utils";
import { cleanCpuProbeRaw, cpuProbeRows, cpuProbeState, type CpuProbeRow, type CpuProbeState } from "@/lib/cpu-probes";
import type { Occupant, Partition, Pool, PoolGpu, RawJob, RawNode, Snapshot } from "@/types/snapshot";

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
        <span className="font-mono text-[11px] text-muted-foreground">
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
  const rawGpuFree = isGpu ? pool.gpu?.free ?? 0 : 0;
  const displayFree = isGpu ? rawGpuFree : pool.cores.free;
  const hasAvailable = (isGpu ? gpuSched > 0 : availableNodes > 0) && !maint;
  const hasStrandedGpu = isGpu && rawGpuFree > 0 && gpuSched <= 0 && !maint;
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
            <span className="text-[11px] text-muted-foreground">
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
            <div className="text-[11px] text-muted-foreground">
              {maint ? null : gpuAvailabilityText(isGpu, gpuFit, gpuSched, rawGpuFree, availableNodesLabel, t)}
            </div>
          </div>
          <ReleaseHint pool={pool} generatedAt={snap.generated_at} />
        </div>

        {isGpu && pool.gpu ? (
          <GpuBlocks gpu={pool.gpu} schedulableFree={gpuSched} className="mt-2" />
        ) : (
          <Bar value={maint ? 0 : util} tone={maint ? "neutral" : undefined} className="mt-2" />
        )}

        <div className="mt-2.5 flex flex-wrap items-center gap-x-4 text-[11px] text-muted-foreground">
          <span>
            <b className="text-ok-fg">{pool.queue.running}</b> {t("queue.running")}
          </span>
          <span>
            <b className={pool.queue.pending ? "text-warn-fg" : "text-foreground"}>{pool.queue.pending}</b>{" "}
            {t("queue.pending")}
          </span>
        </div>

        {pool.queue.running > 0 && (
          <>
            <button
              type="button"
              onClick={() => setOpen(!open)}
              className="mt-3 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-90")} />
              {t("pool.occupants")} ({pool.queue.running})
            </button>
            {open && <Occupants pool={pool} t={t} />}
          </>
        )}

        {pool.queue.pending > 0 && (
          <>
            <button
              type="button"
              onClick={() => setQueueOpen(!queueOpen)}
              className="mt-2 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", queueOpen && "rotate-90")} />
              {t("pool.pendingJobs")} ({pool.queue.pending})
            </button>
            {queueOpen && <PendingJobs pool={pool} t={t} />}
          </>
        )}

        {!maint && <RequestSample pool={pool} t={t} />}
      </CardContent>
    </Card>
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
    <div className="flex flex-col items-end gap-1 text-right text-[11px]">
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
  const [mode, setMode] = useState<"interactive" | "script">("interactive");
  const [scriptFile, setScriptFile] = useState("job.sh");
  const [advanced, setAdvanced] = useState(false);
  const [nodes, setNodes] = useState("");
  const [cores, setCores] = useState("");
  const [mem, setMem] = useState("");
  const [time, setTime] = useState("");
  const [copied, setCopied] = useState(false);
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
  const queueFact = snap ? poolQueueFact(snap.jobs, snap.part_pool, pool.id, isGpu, pool, effectiveGpuFit?.schedulable ?? 0) : null;
  const limits = policyLimitRows(policy, groupRunning, t);
  const groupLimitReached = Boolean(policy.grpJobs && groupRunning >= policy.grpJobs);
  const nodeCount = clampPositiveInt(nodes, cap.maxNodes);
  const coreCount = clampPositiveInt(cores, cap.maxCores);
  const cpuRows = snap && !isGpu && pool.id === "cpu" ? cpuProbeRows(pool, snap) : [];
  const cpuProbeGeneratedAt = snap?.cpu_submit_probes_generated_at || snap?.generated_at || 0;
  const hasAdvancedOverrides = Boolean(nodeCount || coreCount || memValue || time.trim());
  const selectedCpuRow = !hasAdvancedOverrides ? cpuRows.find((row) => row.partition === partition) ?? null : null;
  const gpuTip = isGpu && gpuFit && gpuFit.schedulable <= 0 ? gpuFitTipCommand(gpuFit, pool) : null;
  const defaultGpuBlocked = Boolean(isGpu && gpuFit && gpuFit.rawFree > 0 && gpuFit.schedulable <= 0);
  const showGpuFitDetails = Boolean(defaultGpuBlocked && !memValue);
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
        t,
      });
  const flags = [`-p ${partition}`, ...(base.requiredFlags ?? [])];
  if (nodeCount) flags.push(`-N ${nodeCount}`);
  if (coreCount) flags.push(`-c ${coreCount}`);
  if (memValue) flags.push(`--mem=${memValue}`);
  if (time.trim()) flags.push(`-t ${time.trim()}`);
  const script = scriptFile.trim() || "job.sh";
  const cmd = mode === "interactive" ? `salloc ${flags.join(" ")}` : `sbatch ${flags.join(" ")} ${script}`;
  const policyName = trMaybe(t, `policy.${partition}`, partition);
  const policyDesc = trMaybe(t, `policy.${partition}.desc`, "");
  const policyLimit = fmtPolicyLimit(cap, t, isGpu);
  const multiNodeCpuPolicy = !isGpu && (cap.maxNodes ?? 1) > 1;
  const nodeOptions = numberOptions(cap.maxNodes, [1, 2, 3, 4, 8, 16, 32]);
  const coreOptions = numberOptions(cap.maxCores, [1, 2, 4, 8, 16, 26, 32, 52, 64, 96, 128, 208, 256, 512, 768, 1024, 2048, 4096, 8192]);
  const timeOptions = timeOptionsFor(cap.wall, t);
  const partitionGroups = partitionOptionGroups(pool.partitions, t);
  const fieldCls = "h-7 w-full rounded-md border border-border bg-background px-2 text-[11px] outline-none focus:border-primary";

  const copy = async () => {
    if (await copyText(cmd)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }
  };

  return (
    <div className="mt-3 border-t border-border pt-2.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-90")} />
          {t("pool.quickRequest")}
        </button>
        {cpuRows.length > 0 && <CpuProbeSummary rows={cpuRows} generatedAt={cpuProbeGeneratedAt} t={t} />}
        {!open && cpuRows.length === 0 && queueHint && (
          <QuickRequestSummary hint={queueHint} tip={gpuTip} t={t} />
        )}
      </div>
      {open && (
        <div className="mt-2 space-y-2">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {pool.partitions.length > 1 && (
              <Field label={t("col.partition")}>
                <select value={partition} onChange={(e) => setPartChoice(e.target.value)} className={fieldCls}>
                  {partitionGroups.map((group) => (
                    group.label ? (
                      <optgroup key={group.key} label={group.label}>
                        {group.items.map((p) => (
                          <option key={p} value={p}>
                            {cpuOptionLabel(p, cpuRows, cpuProbeGeneratedAt, t)}
                          </option>
                        ))}
                      </optgroup>
                    ) : (
                      <Fragment key={group.key}>
                        {group.items.map((p) => (
                          <option key={p} value={p}>
                            {cpuOptionLabel(p, cpuRows, cpuProbeGeneratedAt, t)}
                          </option>
                        ))}
                      </Fragment>
                    )
                  ))}
                </select>
              </Field>
            )}
            <Field label={t("pool.mode")}>
              <div className="flex h-7 rounded-md border border-border p-0.5">
                {(["interactive", "script"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setMode(m)}
                    className={cn(
                      "flex-1 rounded-[4px] px-2 text-[11px] transition-colors",
                      mode === m ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {t(m === "interactive" ? "pool.modeInteractive" : "pool.modeScript")}
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
          <div className="rounded-md border border-border bg-muted/30 px-2.5 py-2">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-xs font-medium text-foreground">{policyName}</span>
              {policyLimit && <span className="font-mono text-[10px] text-muted-foreground">{policyLimit}</span>}
            </div>
            {policyDesc && <div className="mt-1 text-[10px] leading-relaxed text-muted-foreground">{policyDesc}</div>}
            {selectedCpuRow && <CpuProbeInline row={selectedCpuRow} generatedAt={cpuProbeGeneratedAt} t={t} />}
            {hasAdvancedOverrides && cpuRows.length > 0 && (
              <div className="mt-1 text-[10px] leading-relaxed text-muted-foreground">{t("pool.cpuProbeDefaultOnly")}</div>
            )}
            {multiNodeCpuPolicy && <div className="mt-1 text-[10px] leading-relaxed text-warn-fg">{t("pool.multiNodeHint")}</div>}
            {queueHint && (!showGpuFitDetails || groupLimitReached) && (
              <div className="mt-1 flex flex-wrap items-center gap-1 text-[10px]">
                <Tag tone={queueHint.tone}>{queueHint.label}</Tag>
                {queueHint.detail && <span className="text-muted-foreground">{queueHint.detail}</span>}
              </div>
            )}
            {showGpuFitDetails && gpuFit && <GpuFitExplanation fit={gpuFit} t={t} />}
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
            {limits.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {limits.map((row) => (
                  <span
                    key={row.key}
                    className={cn(
                      "rounded-md border px-1.5 py-0.5 text-[10px]",
                      row.reached
                        ? "border-bad/40 bg-bad-soft text-bad-fg"
                        : row.near
                          ? "border-warn/40 bg-warn-soft text-warn-fg"
                          : "border-border bg-background/70 text-muted-foreground",
                    )}
                  >
                    {row.label}
                  </span>
                ))}
              </div>
            )}
            {groupLimitReached && <div className="mt-1 text-[10px] leading-relaxed text-bad-fg">{t("pool.limitReached")}</div>}
          </div>
          <button
            type="button"
            onClick={() => setAdvanced(!advanced)}
            className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
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
                  {memError && <span className="mt-0.5 block text-[10px] leading-tight text-bad-fg">{memError}</span>}
                </Field>
                <Field label={t("pool.time")}>
                  <select value={time} onChange={(e) => setTime(e.target.value)} className={fieldCls}>
                    {timeOptions.map((opt) => (
                      <option key={opt.value || "default"} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </Field>
              </div>
              <div className="text-[10px] leading-relaxed text-muted-foreground">{t("pool.nodeRequestHint")}</div>
            </div>
          )}
          <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-2.5 py-1.5">
            <code className="flex-1 overflow-x-auto whitespace-nowrap font-mono text-[11px]">{cmd}</code>
            <button
              type="button"
              onClick={copy}
              className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              {t(copied ? "helper.copied" : "helper.copy")}
            </button>
          </div>
        </div>
      )}
    </div>
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
  if (isGpu && gpuFit && gpuFit.rawFree > 0 && gpuFit.schedulable <= 0) return warn(gpuFitShortText(gpuFit, t));
  if (isGpu && queueFact && queueFact.free <= 0 && (part.gpu?.free ?? 0) > 0) return warn(t("pool.queueReasonGpuFit"));
  if (!isGpu && coreCount > 0 && poolFree && coreCount > poolFree.emptiestNodeFree) return warn(t("pool.queueReasonCores"));

  if (queueFact && queueFact.pending > 0) {
    return {
      tone: "warn" as const,
      label: t("pool.queueHintQueued"),
      detail: queueFactText(queueFact, t),
    };
  }
  return { tone: "ok" as const, label: t("pool.queueHintCanStart"), detail: "" };
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

function limitLevel(current: number, max: number) {
  return {
    reached: current >= max,
    near: max > 1 && current >= Math.ceil(max * 0.8),
  };
}

function policyLimitRows(policy: PartitionPolicy, groupRunning: number, t: TFn) {
  const rows: Array<{ key: string; label: string; reached: boolean; near: boolean }> = [];
  if (policy.grpJobs) {
    rows.push({
      key: "grp",
      label: t("pool.limitGroup", { n: groupRunning, max: policy.grpJobs }),
      ...limitLevel(groupRunning, policy.grpJobs),
    });
  }
  if (policy.maxJobsPerUser) {
    rows.push({
      key: "userRun",
      label: t("pool.limitUserRunning", { max: policy.maxJobsPerUser }),
      reached: false,
      near: false,
    });
  }
  if (policy.maxSubmitPerUser) {
    rows.push({
      key: "userSubmit",
      label: t("pool.limitUserSubmitted", { max: policy.maxSubmitPerUser }),
      reached: false,
      near: false,
    });
  }
  return rows;
}

function QuickRequestSummary({
  hint,
  tip,
  t,
}: {
  hint: NonNullable<ReturnType<typeof requestQueueHint>>;
  tip: GpuFitTipData | null;
  t: TFn;
}) {
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10px]">
      <Tag tone={hint.tone}>{hint.label}</Tag>
      {tip ? (
        <span className="text-muted-foreground">{t("pool.quickGpuMemHint", { mem: tip.mem })}</span>
      ) : hint.detail ? (
        <span className="max-w-[22rem] truncate text-muted-foreground">{hint.detail}</span>
      ) : null}
    </span>
  );
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
    <div className="mt-2 rounded-md border border-warn/40 bg-warn-soft/45 px-2 py-1.5 text-[10px] leading-relaxed">
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

function CpuProbeSummary({ rows, generatedAt, t }: { rows: CpuProbeRow[]; generatedAt: number; t: TFn }) {
  const byState = rows.reduce(
    (acc, row) => {
      acc[cpuProbeState(row.probe, generatedAt)].push(row.partition);
      return acc;
    },
    { now: [] as string[], queued: [] as string[], failed: [] as string[], unknown: [] as string[] },
  );
  return (
    <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10px]">
      <span className="text-muted-foreground">{t("pool.cpuProbeTitle")}:</span>
      {byState.now.length > 0 ? (
        <span className="text-ok-fg">
          {t("pool.cpuProbeNow")} {byState.now.join(", ")}
        </span>
      ) : (
        <span className="text-warn-fg">{t("pool.cpuProbeNoImmediate")}</span>
      )}
      {byState.queued.length > 0 && (
        <span className="text-warn-fg">
          {t("pool.cpuProbeQueued")} {byState.queued.join(", ")}
        </span>
      )}
      {byState.failed.length > 0 && (
        <span className="text-bad-fg">
          {t("pool.cpuProbeFailed")} {byState.failed.join(", ")}
        </span>
      )}
      {byState.unknown.length > 0 && (
        <span className="text-muted-foreground">
          {t("pool.cpuProbeNoData")} {byState.unknown.join(", ")}
        </span>
      )}
    </span>
  );
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
    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px]">
      <Tag tone={cpuProbeTone(state)}>{cpuProbeLabel(state, t)}</Tag>
      <span className="font-mono text-muted-foreground">{t("pool.cpuProbeNeed", { cores: row.cores })}</span>
      {detail && <span className="min-w-0 truncate text-muted-foreground">{detail}</span>}
      <span className="font-mono text-info-fg">{row.command}</span>
    </div>
  );
}

function cpuProbeLabel(state: CpuProbeState, t: TFn) {
  if (state === "now") return t("pool.cpuProbeNow");
  if (state === "queued") return t("pool.cpuProbeQueued");
  if (state === "unknown") return t("pool.cpuProbeNoData");
  return t("pool.cpuProbeFailed");
}

function cpuProbeTone(state: CpuProbeState) {
  if (state === "now") return "ok" as const;
  if (state === "queued") return "warn" as const;
  if (state === "unknown") return "neutral" as const;
  return "bad" as const;
}

function cpuProbeDetail(row: CpuProbeRow, state: CpuProbeState, t: TFn) {
  const probe = row.probe;
  if (!probe) return t("pool.cpuProbeNoData");
  if (state === "now") return probe.nodes ? t("pool.cpuProbeNodes", { nodes: probe.nodes }) : "";
  if (state === "queued" && probe.start_time) return t("pool.cpuProbeStart", { time: clockOf(probe.start_time) });
  return truncateProbeRaw(cleanCpuProbeRaw(probe.raw));
}

function truncateProbeRaw(text: string) {
  if (!text) return "";
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

function trMaybe(t: TFn, key: string, fallback: string) {
  const translated = t(key as TranslationKey);
  return translated === key ? fallback : translated;
}

function fmtPolicyLimit(cap: ReturnType<typeof partitionCap>, t: TFn, isGpu: boolean) {
  const parts = [
    cap.maxNodes ? `${cap.maxNodes} ${t("spec.nodes")}` : "",
    isGpu && cap.maxGpus ? `${cap.maxGpus} ${t("pool.gpuTotal")}` : "",
    cap.maxCores ? `${cap.maxCores} ${t("unit.cores")}` : "",
    cap.maxMemGb ? `${cap.maxMemGb} GB` : "",
    cap.wall ?? "",
  ].filter(Boolean);
  return parts.length ? `${t("part.policyLimit")}: ${parts.join(" / ")}` : "";
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="min-w-0 text-[10px] text-muted-foreground">
      <span className="mb-0.5 block truncate">{label}</span>
      {children}
    </label>
  );
}

function gpuAvailabilityText(isGpu: boolean, fit: GpuFitInfo | null, schedulable: number, rawFree: number, availableLabel: string, t: TFn) {
  if (!isGpu) return availableLabel;
  if (schedulable > 0) return availableLabel;
  if (rawFree > 0) return gpuStrandedText(fit, rawFree, t);
  return t("gpu.full");
}

function gpuStrandedText(fit: GpuFitInfo | null, rawFree: number, t: TFn) {
  const rows = fit?.stranded ?? [];
  const mem = rows.some((row) => row.missingMemMb > 0);
  const cpu = rows.some((row) => row.missingCores > 0);
  if (cpu && mem) return t("pool.gpuStrandedCpuMem", { n: rawFree });
  if (cpu) return t("pool.gpuStrandedCpu", { n: rawFree });
  if (mem) {
    const tip = gpuStrandedMemTip(fit);
    return tip ? t("pool.gpuStrandedMemTip", { n: rawFree, mem: tip }) : t("pool.gpuStrandedMem", { n: rawFree });
  }
  return t("pool.gpuStranded", { n: rawFree });
}

function gpuStrandedMemTip(fit: GpuFitInfo | null) {
  const best = fit?.stranded.find((row) => row.freeGpu >= 1 && row.freeCores >= fit.need.cores && row.freeMemMb > 1024);
  if (!best) return "";
  const memGb = conservativeMemGb(best.freeMemMb);
  return memGb > 0 ? `${memGb}G` : "";
}

interface GpuFitNeed {
  partition: string;
  gpus: number;
  cores: number;
  memMb: number;
}

interface GpuFitNode {
  node: RawNode;
  freeGpu: number;
  usedGpu: number;
  freeCores: number;
  freeMemMb: number;
  missingGpu: number;
  missingCores: number;
  missingMemMb: number;
  occupants: RawJob[];
}

interface GpuFitInfo {
  need: GpuFitNeed;
  rawFree: number;
  schedulable: number;
  stranded: GpuFitNode[];
  fitNodes: GpuFitNode[];
}

interface GpuFitTipData {
  mem: string;
  node: string;
}

function schedulableGpuSlots(nodes: RawNode[], pool: Pool, cap: ReturnType<typeof partitionCap>) {
  return gpuFitFromNodes(nodes, [], pool, cap, "").schedulable;
}

function gpuFitSnapshot(snap: Snapshot, pool: Pool, cap: ReturnType<typeof partitionCap>, partition: string): GpuFitInfo {
  return gpuFitFromNodes(snap.nodes, snap.jobs, pool, cap, partition);
}

function gpuFitFromNodes(nodes: RawNode[], jobs: RawJob[], pool: Pool, cap: ReturnType<typeof partitionCap>, partition: string): GpuFitInfo {
  const need = gpuFitNeed(nodes, pool, cap, partition);
  const byNode = jobs.length ? runningJobsByNode(jobs) : new Map<string, RawJob[]>();
  const stranded: GpuFitNode[] = [];
  const fitNodes: GpuFitNode[] = [];
  if (!pool.gpu) return { need, rawFree: 0, schedulable: 0, stranded, fitNodes };
  const perGpuCores = need.cores;
  const perGpuMemMb = need.memMb;
  let rawFree = 0;
  let slots = 0;
  for (const node of nodes) {
    if (node.pool !== pool.id || !nodeUp(node)) continue;
    const freeGpu = Math.max(0, parseGpuCount(node.gres, pool.gpu.type) - parseGpuCount(node.gres_used, pool.gpu.type));
    if (freeGpu <= 0) continue;
    rawFree += freeGpu;
    const freeCores = Math.max(0, node.cpus - node.alloc_cpus);
    const freeMem = Math.max(0, node.real_memory - node.alloc_memory);
    const nodeSlots = Math.min(
      freeGpu,
      Math.floor(freeCores / perGpuCores),
      perGpuMemMb ? Math.floor(freeMem / perGpuMemMb) : freeGpu,
    );
    slots += nodeSlots;
    const row: GpuFitNode = {
      node,
      freeGpu,
      usedGpu: parseGpuCount(node.gres_used, pool.gpu.type),
      freeCores,
      freeMemMb: freeMem,
      missingGpu: Math.max(0, need.gpus - freeGpu),
      missingCores: Math.max(0, perGpuCores - freeCores),
      missingMemMb: perGpuMemMb ? Math.max(0, perGpuMemMb - freeMem) : 0,
      occupants: byNode.get(node.name) ?? [],
    };
    if (nodeSlots > 0) fitNodes.push(row);
    else stranded.push(row);
  }
  stranded.sort((a, b) => shortageScore(a) - shortageScore(b) || a.node.name.localeCompare(b.node.name));
  fitNodes.sort((a, b) => b.freeGpu - a.freeGpu || b.freeCores - a.freeCores || b.freeMemMb - a.freeMemMb);
  return { need, rawFree, schedulable: slots, stranded, fitNodes };
}

function gpuFitWithMemOverride(fit: GpuFitInfo, memMb: number): GpuFitInfo {
  if (memMb <= 0) return fit;
  const rows = [...fit.fitNodes, ...fit.stranded].map((row) => {
    const nodeSlots = Math.min(
      row.freeGpu,
      Math.floor(row.freeCores / fit.need.cores),
      Math.floor(row.freeMemMb / memMb),
    );
    return {
      ...row,
      missingMemMb: Math.max(0, memMb - row.freeMemMb),
      missingCores: Math.max(0, fit.need.cores - row.freeCores),
      missingGpu: Math.max(0, fit.need.gpus - row.freeGpu),
      nodeSlots,
    };
  });
  const fitNodes = rows.filter((row) => row.nodeSlots > 0).map(({ nodeSlots: _nodeSlots, ...row }) => row);
  const stranded = rows.filter((row) => row.nodeSlots <= 0).map(({ nodeSlots: _nodeSlots, ...row }) => row);
  stranded.sort((a, b) => shortageScore(a) - shortageScore(b) || a.node.name.localeCompare(b.node.name));
  fitNodes.sort((a, b) => b.freeGpu - a.freeGpu || b.freeCores - a.freeCores || b.freeMemMb - a.freeMemMb);
  return {
    ...fit,
    need: { ...fit.need, memMb },
    schedulable: rows.reduce((sum, row) => sum + Math.max(0, row.nodeSlots), 0),
    fitNodes,
    stranded,
  };
}

function gpuFitNeed(nodes: RawNode[], pool: Pool, cap: ReturnType<typeof partitionCap>, partition: string): GpuFitNeed {
  const maxGpus = Math.max(1, cap.maxGpus ?? 1);
  const cores = Math.max(1, Math.ceil((cap.maxCores ?? 1) / maxGpus));
  const capMemMb = cap.maxMemGb ? Math.ceil((cap.maxMemGb * 1000) / maxGpus) : 0;
  const observedMem = pool.gpu
    ? Math.max(0, ...nodes
        .filter((node) => node.pool === pool.id)
        .map((node) => {
          const usedGpu = parseGpuCount(node.gres_used, pool.gpu!.type);
          if (usedGpu <= 0) return 0;
          const mem = parseTresMemoryMb(node.alloc_tres) || node.alloc_memory;
          return mem > 0 ? Math.ceil(mem / usedGpu) : 0;
        }))
    : 0;
  return {
    partition,
    gpus: 1,
    cores,
    memMb: Math.max(capMemMb, observedMem),
  };
}

function runningJobsByNode(jobs: RawJob[]) {
  const byNode = new Map<string, RawJob[]>();
  for (const job of jobs) {
    if (String(job.job_state || "").toUpperCase() !== "RUNNING" || !job.nodelist) continue;
    for (const node of expandHostlist(job.nodelist)) {
      const list = byNode.get(node) ?? [];
      list.push(job);
      byNode.set(node, list);
    }
  }
  for (const list of byNode.values()) {
    list.sort((a, b) => (b.gpus || 0) - (a.gpus || 0) || (b.cpus || 0) - (a.cpus || 0));
  }
  return byNode;
}

function shortageScore(row: GpuFitNode) {
  return row.missingGpu * 1_000_000_000 + row.missingCores * 1_000_000 + row.missingMemMb;
}

function parseTresMemoryMb(text: string) {
  if (!text) return 0;
  const m = text.match(/(?:^|,)mem=(\d+(?:\.\d+)?)([KMGTP]?)/i);
  if (!m) return 0;
  const n = Number(m[1]);
  const unit = m[2].toUpperCase();
  const mult: Record<string, number> = { "": 1, K: 1 / 1024, M: 1, G: 1024, T: 1024 * 1024, P: 1024 * 1024 * 1024 };
  return Math.round(n * (mult[unit] ?? 1));
}

function gpuFitTipCommand(fit: GpuFitInfo, pool: Pool): GpuFitTipData | null {
  if (!pool.gpu || fit.schedulable > 0) return null;
  const best = fit.stranded.find((row) => row.freeGpu >= 1 && row.freeCores >= fit.need.cores && row.freeMemMb > 1024);
  if (!best) return null;
  const memGb = conservativeMemGb(best.freeMemMb);
  if (memGb <= 0) return null;
  const mem = `${memGb}G`;
  return {
    mem,
    node: best.node.name,
  };
}

function conservativeMemGb(freeMemMb: number) {
  const freeGiB = freeMemMb / 1024;
  const rounded = Math.floor((freeGiB - 4) / 10) * 10;
  if (rounded >= 10) return rounded;
  return Math.max(1, Math.floor(freeGiB - 1));
}

function GpuFitExplanation({ fit, t }: { fit: GpuFitInfo; t: TFn }) {
  const rows = fit.stranded.slice(0, 4);
  if (rows.length === 0) return null;
  const more = Math.max(0, fit.stranded.length - rows.length);
  return (
    <div className="mt-2 rounded-md border border-warn/35 bg-warn-soft/45 px-2.5 py-2 text-[10px] leading-relaxed">
      <div className="flex flex-wrap items-center gap-1.5">
        <Tag tone="warn">{t("pool.fitBlocked")}</Tag>
        <span className="text-foreground">{t("pool.fitNeed", { partition: fit.need.partition, need: resourceText(fit.need, t) })}</span>
      </div>
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

function parseGpuCount(text: string, type: string) {
  if (!text) return 0;
  const typed = new RegExp(`gpu:${type.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:?(\\d+)|gres/gpu:${type.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}=(\\d+)`);
  const m = text.match(typed) ?? text.match(/gpu:[A-Za-z0-9_-]+:?(\\d+)|gres\/gpu:[A-Za-z0-9_-]+=(\d+)|gpu:(\d+)/);
  if (!m) return 0;
  return Number(m[1] ?? m[2] ?? m[3] ?? 0);
}

function nodeUp(node: RawNode) {
  return !node.state.some((s) => ["DOWN", "DRAIN", "NOT_RESPONDING"].includes(String(s).toUpperCase()));
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

function pendingForPool(jobs: RawJob[], partPool: Record<string, string>, poolId: string) {
  return jobs
    .filter((j) => String(j.job_state).toUpperCase() === "PENDING")
    .filter((j) => String(j.partition || "").split(",").some((p) => partPool[p] === poolId));
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
      <div className="pb-1 text-[10px] text-muted-foreground">{t("pool.pendingShowing", { shown: list.length, total: all.length })}</div>
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
    <div className="rounded-md bg-muted/40 px-2.5 py-1.5 text-[11px]">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-info-fg">{job.user_name}</span>
        <div className="flex items-center gap-2 font-mono text-muted-foreground">
          <span>{job.partition}</span>
          <span className="text-foreground">{pendingJobResources(job, t)}</span>
        </div>
      </div>
      <div className="mt-1 truncate text-[10px] text-muted-foreground">
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

function isLimitBlocked(job: RawJob) {
  const reason = String(job.state_reason || "");
  return reason.startsWith("QOSMax") || reason === "Dependency" || reason === "JobArrayTaskLimit";
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
  let list = needle
    ? all.filter((o) => o.user.toLowerCase().includes(needle) || o.nodelist.toLowerCase().includes(needle))
    : all;
  const effectiveSort = isGpu ? "ending" : sort;
  if (effectiveSort === "ending") {
    list = [...list].sort((a, b) => (a.end_time || "~").localeCompare(b.end_time || "~"));
  }
  return (
    <div className="mt-2">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("table.search")}
          aria-label={t("table.search")}
          className="h-7 w-40 rounded-md border border-border bg-background px-2 text-[11px] outline-none focus:border-primary"
        />
        {isGpu ? (
          <span className="rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground">
            {t("pool.sortEnding")}
          </span>
        ) : (
          <div className="flex items-center rounded-md border border-border p-0.5">
            {(["ending", "usage"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSort(s)}
                className={cn(
                  "rounded px-2 py-0.5 text-[11px] transition-colors",
                  sort === s ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {t(s === "usage" ? "pool.sortUsage" : "pool.sortEnding")}
              </button>
            ))}
          </div>
        )}
        <span className="tnum ml-auto text-[11px] text-muted-foreground">
          {list.length}/{all.length}
        </span>
      </div>
      <div className="max-h-72 space-y-1 overflow-y-auto pr-1">
        {list.map((o) => (
          <OccupantRow key={String(o.job_id)} o={o} now={now} generatedAt={snap.generated_at} t={t} />
        ))}
        {list.length === 0 && (
          <div className="py-3 text-center text-[11px] text-muted-foreground">{t("table.noresults")}</div>
        )}
      </div>
      {pool.partitions.length > 0 && (
        <div className="pt-2 text-[11px] text-muted-foreground">
          {t("pool.submit")}: <span className="font-mono">{pool.partitions.join(", ")}</span>
        </div>
      )}
    </div>
  );
}

function OccupantRow({
  o,
  now,
  generatedAt,
  t,
}: {
  o: Occupant;
  now: number;
  generatedAt: number;
  t: TFn;
}) {
  // live remaining = remaining-at-snapshot minus seconds elapsed since the snapshot
  const total = parseDur(o.time_limit);
  const remaining = Math.max(0, parseDur(o.time_left) - (now - generatedAt));
  const remFrac = total > 0 ? Math.min(1, remaining / total) : 0;
  const elapsed = 1 - remFrac;
  // bar drains as the job runs; greens → amber → red as it nears its end
  const barColor = elapsed >= 0.85 ? "bg-bad" : elapsed >= 0.6 ? "bg-warn" : "bg-ok";
  return (
    <div className="rounded-md bg-muted/40 px-2.5 py-1.5 text-[11px]">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-info-fg">{o.user}</span>
        <div className="flex items-center gap-2 font-mono text-muted-foreground">
          <span className="text-foreground">{occupantResources(o, t)}</span>
          <span className="max-w-[8rem] truncate">{o.nodelist}</span>
        </div>
      </div>
      <div className="mt-1 flex items-center gap-2">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
          <div
            className={cn("h-full rounded-full transition-all duration-1000 ease-linear", barColor)}
            style={{ width: `${remFrac * 100}%` }}
          />
        </div>
        <span className="tnum shrink-0 font-mono text-[10px]">
          <span className="text-foreground">{fmtCountdown(remaining)}</span>
          {total > 0 && <span className="text-muted-foreground"> / {fmtDur(total)}</span>}
        </span>
      </div>
    </div>
  );
}

function occupantResources(o: Occupant, t: TFn) {
  const parts = [];
  if (o.gpus > 0) parts.push(`${o.gpus} ${t("unit.gpu")}`);
  if (o.cpus > 0) parts.push(`${o.cpus}c`);
  if (o.mem_mb > 0) parts.push(fmtMB(o.mem_mb));
  return parts.join(" · ") || "—";
}
