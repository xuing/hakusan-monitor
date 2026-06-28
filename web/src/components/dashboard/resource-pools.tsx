import { useState, type ReactNode } from "react";
import { Check, ChevronRight, Copy } from "lucide-react";
import { Bar } from "@/components/common/bar";
import { Tag } from "@/components/common/tag";
import { Card, CardContent } from "@/components/ui/card";
import { useLive } from "@/hooks/use-live";
import { useResourceFilter } from "@/hooks/use-resource-filter";
import { poolLabel, useT, type TFn } from "@/i18n";
import { occupantsForPool } from "@/lib/derive";
import { clockOf, fmtLeft, fmtMB, nf } from "@/lib/format";
import { matchPool, partitionCap } from "@/lib/slurm";
import { cn } from "@/lib/utils";
import type { Occupant, Pool } from "@/types/snapshot";

// Single-node starter recipe per pool. On Hakusan memory is locked to cores
// (DefMemPerCPU == MaxMemPerCPU), so we don't pass --mem — it auto-scales with -c.
// memPerCoreMb mirrors the cluster's DefMemPerCPU, used only to *show* the implied RAM.
const SAMPLE: Record<string, { partition: string; cores: number; memPerCoreMb: number; gres?: string }> = {
  "vm-cpu": { partition: "VM-CPU", cores: 8, memPerCoreMb: 14900 },
  cpu: { partition: "DEF", cores: 16, memPerCoreMb: 6000 },
  lm: { partition: "VM-LM", cores: 8, memPerCoreMb: 39300 },
  a40: { partition: "GPU-1", cores: 8, memPerCoreMb: 10000, gres: "nvidia_a40" },
  a100: { partition: "GPU-1A", cores: 8, memPerCoreMb: 10000, gres: "nvidia_a100" },
  "h100-80": { partition: "VM-GPU-L", cores: 8, memPerCoreMb: 14900, gres: "h100-80c" },
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
          <PoolGroup key={g.key} label={g.label} pools={g.pools} t={t} />
        ))}
      </div>
    </div>
  );
}

function PoolGroup({ label, pools, t }: { label: string; pools: Pool[]; t: TFn }) {
  const available = pools.filter(hasAvailableNodes).length;
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
          <PoolCard key={p.id} pool={p} t={t} />
        ))}
      </div>
    </section>
  );
}

function PoolCard({ pool, t }: { pool: Pool; t: TFn }) {
  const [open, setOpen] = useState(false);
  const isGpu = pool.kind === "gpu";
  const maint = isMaintPool(pool);
  const availableNodes = pool.available_nodes ?? pool.idle_nodes ?? 0;
  const hasAvailable = availableNodes > 0 && !maint;
  const availableNodesLabel = isGpu
    ? t("pool.gpuNodesWithFree", { n: availableNodes })
    : t("pool.availableNodes", { n: availableNodes });
  const free = isGpu ? pool.gpu?.free ?? 0 : pool.cores.free;
  const total = isGpu && pool.gpu ? pool.gpu.total : pool.cores.total;
  const used = isGpu && pool.gpu ? pool.gpu.used : pool.cores.alloc;
  const util = total ? used / total : 0;   // bar fills as the pool gets used (full = red)
  const freeRatio = total ? free / total : 0;
  // colour by how much is free: none = red, scarce (<10%) = amber, plenty = green
  const freeColor = maint
    ? "text-muted-foreground"
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
                {nf(free)}
                <span className="text-sm font-normal text-muted-foreground">
                  {" / "}
                  {nf(total)} {isGpu ? t("unit.gpu") : t("unit.cores")}
                </span>
              </div>
            )}
            <div className="text-[11px] text-muted-foreground">
              {maint
                ? null
                : free === 0
                  ? t("gpu.full")
                  : availableNodes > 0
                    ? `${t("part.available")} · ${availableNodesLabel}`
                    : t("part.available")}
            </div>
          </div>
          <div className="flex flex-col items-end gap-1 text-right text-[11px]">
            {isGpu && pool.gpu?.next_free && (
              <span className="text-info-fg">
                ~ {clockOf(pool.gpu.next_free.at)}{" "}
                <span className="text-muted-foreground">({fmtLeft(pool.gpu.next_free.left)})</span>
              </span>
            )}
            {pool.queue.releasing.nodes > 0 && <Tag tone="info">↑{pool.queue.releasing.nodes}</Tag>}
          </div>
        </div>

        <Bar value={maint ? 0 : util} tone={maint ? "neutral" : undefined} className="mt-2" />

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

        {!maint && <RequestSample pool={pool} t={t} />}
      </CardContent>
    </Card>
  );
}

/** Collapsible, editable starter request for this pool. Collapsed by default;
 *  pre-filled with sensible single-node defaults, fields let you adjust. */
function RequestSample({ pool, t }: { pool: Pool; t: TFn }) {
  const base = SAMPLE[pool.id];
  const [open, setOpen] = useState(false);
  const [partChoice, setPartChoice] = useState("");
  const [cores, setCores] = useState(base?.cores ?? 8);
  const [gpus, setGpus] = useState(1);
  const [copied, setCopied] = useState(false);
  if (!base) return null;

  const isGpu = pool.kind === "gpu";
  const partition = pool.partitions.includes(partChoice) ? partChoice : base.partition;
  const cap = partitionCap(partition);
  // clamp every field to the selected partition's policy → the command is never over-limit
  const clamp = (v: number, fallback: number, max?: number) => {
    const n = v > 0 ? v : fallback;
    return max ? Math.min(n, max) : n;
  };
  const c = clamp(cores, base.cores, cap.maxCores);
  const g = clamp(gpus, 1, cap.maxGpus);
  // no --mem: Hakusan locks memory to cores, so RAM = cores × DefMemPerCPU (shown, not requested)
  const autoMemGb = Math.round((c * base.memPerCoreMb) / 1024);
  const flags = [`-p ${partition}`, "-N 1", "-n 1", `-c ${c}`];
  if (base.gres) flags.push(`--gres=gpu:${base.gres}:${g}`);
  const cmd = `salloc ${flags.join(" ")}`;
  const capLabel = (label: string, max?: number) => (max ? `${label} ≤${max}` : label);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable */
    }
  };

  const fieldCls = "h-7 w-full rounded-md border border-border bg-background px-2 text-[11px] outline-none focus:border-primary";

  return (
    <div className="mt-3 border-t border-border pt-2.5">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-90")} />
        {t("pool.quickRequest")}
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {pool.partitions.length > 1 && (
              <Field label={t("col.partition")}>
                <select value={partition} onChange={(e) => setPartChoice(e.target.value)} className={fieldCls}>
                  {pool.partitions.map((p) => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
              </Field>
            )}
            <Field label={capLabel(t("unit.cores"), cap.maxCores)}>
              <input type="number" min={1} max={cap.maxCores} value={c} onChange={(e) => setCores(Number(e.target.value))} className={fieldCls} />
            </Field>
            {isGpu && base.gres && (
              <Field label={capLabel(t("unit.gpu"), cap.maxGpus)}>
                <input type="number" min={1} max={cap.maxGpus} value={g} onChange={(e) => setGpus(Number(e.target.value))} className={fieldCls} />
              </Field>
            )}
          </div>
          <div className="text-[10px] text-muted-foreground">{t("pool.autoMem", { n: autoMemGb })}</div>
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

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="min-w-0 text-[10px] text-muted-foreground">
      <span className="mb-0.5 block truncate">{label}</span>
      {children}
    </label>
  );
}

function isMaintPool(pool: Pool) {
  return pool.kind === "gpu" && !!pool.gpu?.maint;
}

function hasAvailableNodes(pool: Pool) {
  return !isMaintPool(pool) && (pool.available_nodes ?? pool.idle_nodes ?? 0) > 0;
}

function Occupants({ pool, t }: { pool: Pool; t: TFn }) {
  const { snap } = useLive();
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"usage" | "ending">("ending");
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
  // bar is relative to the biggest current occupant, so it stays meaningful even
  // in huge pools (where share-of-pool would be an invisible sliver).
  const maxVal = Math.max(1, ...list.map((o) => (isGpu ? o.gpus : o.cpus)));

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
          <OccupantRow key={String(o.job_id)} o={o} unitGpu={isGpu} max={maxVal} t={t} />
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

function OccupantRow({ o, unitGpu, max, t }: { o: Occupant; unitGpu: boolean; max: number; t: TFn }) {
  const share = max ? (unitGpu ? o.gpus : o.cpus) / max : 0;
  return (
    <div className="rounded-md bg-muted/40 px-2.5 py-1.5 text-[11px]">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-info-fg">{o.user}</span>
        <div className="flex items-center gap-2 font-mono text-muted-foreground">
          <span className="text-foreground">{o.gpus ? `${o.gpus} ${t("unit.gpu")}` : `${o.cpus}c`}</span>
          <span className="max-w-[8rem] truncate">{o.nodelist}</span>
          <span className="text-ok-fg">{t("releases.in", { t: fmtLeft(o.time_left) })}</span>
        </div>
      </div>
      <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-info" style={{ width: `${Math.max(2, Math.min(100, share * 100))}%` }} />
      </div>
    </div>
  );
}
