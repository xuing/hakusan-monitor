import type { ColumnDef } from "@tanstack/react-table";
import { reasonLabel, type TFn } from "@/i18n";
import { fmtAt, fmtEpoch, fmtLeft, fmtMB } from "@/lib/format";
import type { RawJob } from "@/types/snapshot";
import { JobStateBadge } from "./cells";
import { commaArrayFilter, exactArrayFilter, setSingleFacet } from "./table-filters";

const mono = (v: string, cls = "") => <span className={`font-mono text-xs ${cls}`}>{v || "—"}</span>;
const clickText = "rounded px-1 py-0.5 text-left transition-colors hover:bg-accent hover:text-foreground";

export function jobColumns<T extends RawJob>(t: TFn): ColumnDef<T>[] {
  return [
    {
      accessorKey: "job_id",
      header: t("col.job"),
      cell: ({ row }) => <span className="font-mono font-medium">{row.original.job_id}</span>,
    },
    { accessorKey: "name", header: t("col.name"), cell: ({ row }) => <span className="text-xs">{row.original.name || "—"}</span> },
    {
      accessorKey: "user_name",
      header: t("col.user"),
      cell: ({ row, table }) => (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setSingleFacet(table, "user_name", row.original.user_name);
          }}
          className={`${clickText} font-mono text-xs text-info-fg`}
        >
          {row.original.user_name}
        </button>
      ),
      filterFn: exactArrayFilter,
    },
    { accessorKey: "account", header: t("col.account"), cell: ({ row }) => mono(row.original.account, "text-muted-foreground") },
    {
      accessorKey: "partition",
      header: t("col.partition"),
      cell: ({ row, table }) => (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setSingleFacet(table, "partition", row.original.partition);
          }}
          className={`${clickText} font-mono text-xs`}
        >
          {row.original.partition}
        </button>
      ),
      filterFn: commaArrayFilter,
    },
    {
      id: "state",
      accessorFn: (j) => j.job_state,
      header: t("col.jobState"),
      cell: ({ row, table }) => <JobStateBadge state={row.original.job_state} onClick={() => setSingleFacet(table, "state", row.original.job_state)} />,
      filterFn: exactArrayFilter,
    },
    {
      id: "reason",
      accessorFn: (j) => j.state_reason,
      header: t("col.reason"),
      // Slurm reports Reason=None for running jobs — a pending-reason label
      // like "Being scheduled" would be nonsense there.
      cell: ({ row }) => (
        <span className="text-xs text-muted-foreground">
          {row.original.job_state === "PENDING" ? reasonLabel(t, row.original.state_reason) : "—"}
        </span>
      ),
    },
    { accessorKey: "node_count", header: t("col.nodes"), cell: ({ row }) => <span className="tnum font-mono text-xs">{row.original.node_count}</span> },
    { accessorKey: "cpus", header: t("col.cpus"), cell: ({ row }) => <span className="tnum font-mono text-xs">{row.original.cpus}</span> },
    { accessorKey: "gpus", header: t("col.gpus"), cell: ({ row }) => <span className="tnum font-mono text-xs">{row.original.gpus || "—"}</span> },
    {
      id: "memory",
      accessorFn: (j) => j.min_memory_mb ?? 0,
      header: t("col.memory"),
      cell: ({ row }) => <span className="tnum font-mono text-xs">{row.original.min_memory_mb ? fmtMB(row.original.min_memory_mb) : "—"}</span>,
    },
    { accessorKey: "qos", header: t("col.qos"), cell: ({ row }) => mono(row.original.qos, "text-muted-foreground") },
    { accessorKey: "nodelist", header: t("col.nodelist"), cell: ({ row }) => mono(row.original.nodelist, "text-muted-foreground") },
    { accessorKey: "time_used", header: t("col.timeUsed"), cell: ({ row }) => mono(row.original.time_used) },
    {
      id: "timeleft",
      accessorFn: (j) => j.time_left,
      header: t("col.timeLeft"),
      cell: ({ row }) => mono(fmtLeft(row.original.time_left)),
    },
    { accessorKey: "time_limit", header: t("col.timeLimit"), cell: ({ row }) => mono(row.original.time_limit, "text-muted-foreground") },
    {
      id: "end",
      accessorFn: (j) => j.end_time,
      header: t("col.endTime"),
      cell: ({ row }) => mono(row.original.end_time ? fmtAt(row.original.end_time) : ""),
    },
    {
      id: "start_est",
      accessorFn: (j) => j.start_est,
      header: t("col.startEst"),
      cell: ({ row }) => mono(row.original.start_est ? fmtAt(row.original.start_est) : "", "text-muted-foreground"),
    },
    {
      id: "submit",
      accessorFn: (j) => j.submit_time,
      header: t("col.submit"),
      cell: ({ row }) => mono(fmtEpoch(row.original.submit_time), "text-muted-foreground"),
    },
  ];
}

export const JOB_HIDDEN = ["account", "qos", "nodelist", "time_limit", "submit", "node_count"];
