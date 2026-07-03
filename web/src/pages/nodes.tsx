import { useMemo } from "react";
import { Clock } from "lucide-react";
import { NODE_HIDDEN, nodeColumns } from "@/components/data/columns-nodes";
import { DataTable, type DataFacet } from "@/components/data/data-table";
import { TableSkeleton } from "@/components/common/table-skeleton";
import { useLive } from "@/hooks/use-live";
import { poolLabel, useT, type TFn } from "@/i18n";
import { poolKindGroups } from "@/components/data/table-filters";
import { jobsOnNode } from "@/lib/derive";
import { fmtCountdown, fmtMB, parseDur } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Occupant, RawNode, Snapshot } from "@/types/snapshot";

const nodeWeight = (n: RawNode) => {
  const s = new Set(n.state.map((x) => x.toUpperCase()));
  if (s.has("DOWN") || s.has("DRAIN") || s.has("NOT_RESPONDING")) return 2;
  if (s.has("ALLOCATED")) return 1;
  return 0;
};

export default function NodesPage() {
  const t = useT();
  const { snap } = useLive();
  const columns = useMemo(() => nodeColumns(t), [t]);

  if (!snap) return <TableSkeleton />;
  const nodes = snap.nodes.slice().sort((a, b) => nodeWeight(a) - nodeWeight(b) || a.name.localeCompare(b.name));
  const facets: DataFacet<RawNode>[] = [
    { columnId: "pool", label: t("jobs.filter.resource"), valueLabel: (v) => poolLabel(t, v), groups: poolKindGroups(snap, t) },
    { columnId: "state", label: t("col.state"), valuesFromRow: (node) => node.state },
    { columnId: "partitions", label: t("col.partition"), valuesFromRow: (node) => node.partitions },
  ];

  return (
    <DataTable
      columns={columns}
      data={nodes}
      facets={facets}
      initialHidden={NODE_HIDDEN}
      pageSize={30}
      renderSubRow={(node) => <NodeJobs snap={snap} node={node} t={t} />}
    />
  );
}

/** Who is running on this node — expanded under the node row. */
function NodeJobs({ snap, node, t }: { snap: Snapshot; node: RawNode; t: TFn }) {
  const jobs = jobsOnNode(snap, node.name);
  if (jobs.length === 0) {
    return <div className="px-4 py-3 text-xs text-muted-foreground">{t("releases.none")}</div>;
  }
  return (
    <div className="px-4 py-3">
      <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {t("pool.occupants")} ({jobs.length})
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(13rem,1fr))] gap-1.5">
        {jobs.map((j) => (
          <NodeJobCard key={String(j.job_id)} job={j} t={t} />
        ))}
      </div>
    </div>
  );
}

function NodeJobCard({ job, t }: { job: Occupant; t: TFn }) {
  const isGpu = job.gpus > 0;
  const accent = isGpu ? "bg-info" : "bg-ok";
  const fg = isGpu ? "text-info-fg" : "text-ok-fg";
  const soft = isGpu ? "bg-info-soft text-info-fg" : "bg-ok-soft text-ok-fg";
  return (
    <div className="rounded-md bg-muted/40 px-2.5 py-1.5 transition-colors hover:bg-muted/60">
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", accent)} />
          <span className="truncate font-mono text-[12px] font-medium text-info-fg">{job.user}</span>
        </span>
        <span className={cn("tnum inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 font-mono text-[10px] font-medium", soft)}>
          <Clock className="h-2.5 w-2.5" />
          {fmtCountdown(parseDur(job.time_left))}
        </span>
      </div>
      <div className="mt-0.5 flex items-center gap-1.5 pl-3 text-[10px] text-muted-foreground">
        <span className={cn("font-medium", fg)}>{nodeJobResources(job, t)}</span>
        <span className="text-muted-foreground/40">·</span>
        <span className="truncate">#{job.job_id}</span>
      </div>
    </div>
  );
}

function nodeJobResources(job: Occupant, t: TFn) {
  const parts = [];
  if (job.gpus > 0) parts.push(`${job.gpus} ${t("unit.gpu")}`);
  if (job.cpus > 0) parts.push(`${job.cpus}c`);
  if (job.mem_mb > 0) parts.push(fmtMB(job.mem_mb));
  return parts.join(" · ") || "—";
}
