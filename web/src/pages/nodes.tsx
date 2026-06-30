import { useMemo } from "react";
import { NODE_HIDDEN, nodeColumns } from "@/components/data/columns-nodes";
import { DataTable, type DataFacet } from "@/components/data/data-table";
import { TableSkeleton } from "@/components/common/table-skeleton";
import { useLive } from "@/hooks/use-live";
import { poolLabel, useT, type TFn } from "@/i18n";
import { jobsOnNode } from "@/lib/derive";
import { fmtLeft, fmtMB } from "@/lib/format";
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
    { columnId: "pool", label: t("jobs.filter.resource"), valueLabel: (v) => poolLabel(t, v) },
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
    <div className="space-y-1.5 px-4 py-3">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {t("pool.occupants")} ({jobs.length})
      </div>
      {jobs.map((j) => (
        <div
          key={String(j.job_id)}
          className="grid grid-cols-[minmax(6rem,1fr)_auto] items-center gap-3 rounded-md bg-background/50 px-2.5 py-1.5 font-mono text-[11px]"
        >
          <span className="truncate text-info-fg">{j.user}</span>
          <div className="flex min-w-0 items-center gap-3 text-muted-foreground">
            <span>#{j.job_id}</span>
            <span className="text-foreground">{nodeJobResources(j, t)}</span>
            <span className="text-ok-fg">{t("releases.in", { t: fmtLeft(j.time_left) })}</span>
          </div>
        </div>
      ))}
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
