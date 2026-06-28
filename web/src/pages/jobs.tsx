import { useMemo } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { JOB_HIDDEN, jobColumns } from "@/components/data/columns-jobs";
import { DataTable } from "@/components/data/data-table";
import { exactArrayFilter } from "@/components/data/table-filters";
import { TableSkeleton } from "@/components/common/table-skeleton";
import { useLive } from "@/hooks/use-live";
import { poolLabel, useT, type TFn } from "@/i18n";
import type { TranslationKey } from "@/i18n/en";
import type { RawJob, Snapshot } from "@/types/snapshot";

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
      filterFn: exactArrayFilter,
    },
  ], [t]);

  if (!snap) return <TableSkeleton />;
  const jobs: JobTableRow[] = snap.jobs.map((j) => ({ ...j, resource_pool: jobResourcePool(j, snap) }));

  return (
    <DataTable
      columns={columns}
      data={jobs}
      initialHidden={[...JOB_HIDDEN, "resource_pool"]}
      pageSize={30}
      facetFilters={[
        { columnId: "state", title: t("jobs.filter.state"), options: optionsFrom(jobs, (j) => j.job_state, (v) => stateLabel(v, t)) },
        { columnId: "resource_pool", title: t("jobs.filter.resource"), options: optionsFrom(jobs, (j) => j.resource_pool, (v) => resourceLabel(v, snap, t)) },
        { columnId: "partition", title: t("col.partition"), options: optionsFrom(jobs, (j) => j.partition) },
        { columnId: "user_name", title: t("col.user"), options: optionsFrom(jobs, (j) => j.user_name) },
      ]}
    />
  );
}

function jobResourcePool(j: RawJob, snap: Snapshot): string {
  if (!j.gpus) return "cpu";
  const part = String(j.partition).split(",")[0];
  return snap.part_pool[part] ?? "gpu";
}

function resourceLabel(key: string, snap: Snapshot, t: TFn) {
  if (key === "cpu") return t("jobs.group.cpu");
  const pool = snap.pools.find((p) => p.id === key);
  return pool ? poolLabel(t, pool.id) : key.toUpperCase();
}

function stateLabel(value: string, t: TFn) {
  const key = `state.${value}` as TranslationKey;
  const label = t(key);
  return label === key ? value : label;
}

function optionsFrom<T>(rows: T[], valueOf: (row: T) => string, labelOf: (value: string) => string = (v) => v) {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const value = String(valueOf(row) || "");
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || labelOf(a[0]).localeCompare(labelOf(b[0])))
    .map(([value, count]) => ({ value, label: labelOf(value), count }));
}
