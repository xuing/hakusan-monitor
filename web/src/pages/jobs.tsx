import { useMemo } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { JOB_HIDDEN, jobColumns } from "@/components/data/columns-jobs";
import { DataTable, type DataFacet } from "@/components/data/data-table";
import { TableSkeleton } from "@/components/common/table-skeleton";
import { useLive } from "@/hooks/use-live";
import { poolLabel, useT, type TFn } from "@/i18n";
import type { TranslationKey } from "@/i18n/en";
import type { RawJob, Snapshot } from "@/types/snapshot";
import { exactArrayFilter, setSingleFacet } from "@/components/data/table-filters";

type JobTableRow = RawJob & { resource_pool: string };

export default function JobsPage() {
  const t = useT();
  const { snap } = useLive();
  const columns = useMemo<ColumnDef<JobTableRow>[]>(() => [
    ...jobColumns<JobTableRow>(t),
    {
      id: "resource_pool",
      accessorFn: (j) => j.resource_pool,
      header: t("jobs.filter.resource"),
      cell: ({ row, table }) => (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setSingleFacet(table, "resource_pool", row.original.resource_pool);
          }}
          className="rounded px-1 py-0.5 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          {resourceLabel(row.original.resource_pool, snap, t)}
        </button>
      ),
      filterFn: exactArrayFilter,
    },
  ], [snap, t]);

  if (!snap) return <TableSkeleton />;
  const jobs: JobTableRow[] = snap.jobs.map((j) => ({ ...j, resource_pool: jobResourcePool(j, snap) }));
  const facets: DataFacet<JobTableRow>[] = [
    { columnId: "resource_pool", label: t("jobs.filter.resource"), valueLabel: (v) => resourceLabel(v, snap, t) },
    { columnId: "state", label: t("jobs.filter.state"), valueLabel: (v) => stateLabel(v, t) },
    { columnId: "partition", label: t("col.partition") },
    { columnId: "user_name", label: t("col.user") },
  ];

  return (
    <DataTable
      columns={columns}
      data={jobs}
      facets={facets}
      initialHidden={[...JOB_HIDDEN, "resource_pool"]}
      pageSize={30}
    />
  );
}

function jobResourcePool(j: RawJob, snap: Snapshot): string {
  if (!j.gpus) return "cpu";
  const part = String(j.partition).split(",")[0];
  return snap.part_pool[part] ?? "gpu";
}

function resourceLabel(key: string, snap: Snapshot | null | undefined, t: TFn) {
  if (key === "cpu") return t("jobs.group.cpu");
  const pool = snap?.pools.find((p) => p.id === key);
  return pool ? poolLabel(t, pool.id) : key.toUpperCase();
}

function stateLabel(value: string, t: TFn) {
  const key = `state.${value}` as TranslationKey;
  const label = t(key);
  return label === key ? value : label;
}
