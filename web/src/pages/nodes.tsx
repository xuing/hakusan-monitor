import { useMemo } from "react";
import { NODE_HIDDEN, nodeColumns } from "@/components/data/columns-nodes";
import { DataTable } from "@/components/data/data-table";
import { TableSkeleton } from "@/components/common/table-skeleton";
import { useLive } from "@/hooks/use-live";
import { useResourceFilter } from "@/hooks/use-resource-filter";
import { useT, type TFn } from "@/i18n";
import { jobsOnNode } from "@/lib/derive";
import { fmtLeft } from "@/lib/format";
import type { RawNode, Snapshot } from "@/types/snapshot";

const nodeWeight = (n: RawNode) => {
  const s = new Set(n.state.map((x) => x.toUpperCase()));
  if (s.has("DOWN") || s.has("DRAIN") || s.has("NOT_RESPONDING")) return 2;
  if (s.has("ALLOCATED")) return 1;
  return 0;
};

export default function NodesPage() {
  const t = useT();
  const { snap } = useLive();
  const { filter } = useResourceFilter();
  const columns = useMemo(() => nodeColumns(t), [t]);

  if (!snap) return <TableSkeleton />;
  const nodes = (filter === "all" ? snap.nodes : snap.nodes.filter((n) => n.pool === filter))
    .slice()
    .sort((a, b) => nodeWeight(a) - nodeWeight(b) || a.name.localeCompare(b.name));
  return (
    <DataTable
      columns={columns}
      data={nodes}
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
    <div className="space-y-1 px-4 py-3">
      <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {t("pool.occupants")} ({jobs.length})
      </div>
      {jobs.map((j) => (
        <div key={String(j.job_id)} className="flex items-center justify-between gap-3 font-mono text-[11px]">
          <span className="text-info-fg">{j.user}</span>
          <div className="flex items-center gap-3 text-muted-foreground">
            <span>#{j.job_id}</span>
            <span className="text-foreground">{j.gpus ? `${j.gpus} ${t("unit.gpu")}` : `${j.cpus}c`}</span>
            <span className="text-ok-fg">{t("releases.in", { t: fmtLeft(j.time_left) })}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
