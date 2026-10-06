// One pool's card: what is free now (lib/pool-status decides its colour),
// and the occupants / pending / quick-request disclosures.
import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { GpuReleaseHint } from "@/components/common/gpu-release-hint";
import { POOL_BORDER, POOL_DOT, POOL_RING, POOL_TEXT } from "@/components/common/pool-tone";
import { UnitBlocks } from "@/components/common/unit-blocks";
import { barCells } from "@/lib/unit-cells";
import { Card, CardContent } from "@/components/ui/card";
import { poolTitle, type TFn } from "@/i18n";
import { unschedulableCores } from "@/lib/derive";
import { fmtMB, nf } from "@/lib/format";
import type { GpuAvailabilitySegment } from "@/lib/gpu-availability";
import { poolGpuAvailability } from "@/lib/gpu-fit";
import { poolTone } from "@/lib/pool-status";
import { cn } from "@/lib/utils";
import type { Pool, PoolGpu, Snapshot } from "@/types/snapshot";
import { gpuSegmentLabel, gpuSegmentTextClass } from "@/components/common/gpu-status";
import { Occupants } from "@/components/pools/pool-occupants";
import { PendingJobs } from "@/components/pools/pool-pending";
import { RequestPanel } from "@/components/request/request-panel";

export function PoolCard({ pool, snap, t }: { pool: Pool; snap: Snapshot; t: TFn }) {
  const [open, setOpen] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  const isGpu = pool.kind === "gpu";
  // one verdict for the dot, the border and the free count — the same the
  // filter chip, the group header and the collapsed quick request read
  const tone = poolTone(snap, pool);
  const maint = tone === "off";
  const availableNodes = pool.available_nodes ?? pool.idle_nodes ?? 0;
  // One classifier decides every GPU number on this card — the same verdict
  // the filter chips, group header, KPIs and Partitions page read.
  const avail = isGpu ? poolGpuAvailability(snap, pool) : null;
  const readyGpu = avail?.ready ?? 0;
  // The header says "N GPUs free": idle GPUs on in-service nodes (= backend
  // gpu.free). Never physicalIdle — that also counts drained and
  // scheduler-held cards, which the body lists as their own segments.
  const freeGpu = avail?.free ?? 0;
  const availableNodesLabel = isGpu
    ? t("pool.gpuFreePhysical", { n: freeGpu })
    : t("pool.availableNodes", { n: availableNodes });
  const free = isGpu ? freeGpu : pool.cores.free;
  const total = isGpu && pool.gpu ? pool.gpu.total : pool.cores.total;
  const cpuHeld = isGpu ? { reserved: 0, down: 0 } : unschedulableCores(snap.nodes, pool.id);

  return (
    <Card
      className={cn(
        // min-w-0: a grid item sizes to its longest unbreakable line without
        // it; the collapsed-row summary and the per-GPU block strip would
        // widen the card past a phone screen
        "min-w-0 transition-colors",
        POOL_BORDER[tone],
      )}
    >
      <CardContent className="p-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span
              className={cn("h-2.5 w-2.5 rounded-full ring-2", POOL_DOT[tone], POOL_RING[tone])}
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
                  <div className={cn("tnum text-2xl font-bold", POOL_TEXT[tone])}>
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
            {/* core shares, one cell per node's worth of cores (barCells);
                phones cap at 48 cells so cells stay ≥ 3 px */}
            {[barCells(total, pool.nodes), Math.min(48, barCells(total, pool.nodes))].map((cells, i) => (
              <UnitBlocks
                key={i}
                free={free}
                used={pool.cores.alloc}
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

          {!maint && <RequestPanel pool={pool} t={t} />}
        </div>
      </CardContent>
    </Card>
  );
}

/** Full-width clickable expander row — the one affordance for every
 *  collapsible section on a pool card (occupants / pending / quick request). */
export function DisclosureRow({
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
