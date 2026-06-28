import type { ColumnDef } from "@tanstack/react-table";
import { reasonLabel, type TFn } from "@/i18n";
import { fmtAt, fmtEpoch, fmtLeft } from "@/lib/format";
import type { RawJob } from "@/types/snapshot";
import { JobStateBadge } from "./cells";
import { exactArrayFilter } from "./table-filters";

const mono = (v: string, cls = "") => <span className={`font-mono text-xs ${cls}`}>{v || "—"}</span>;

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
      cell: ({ row }) => <span className="font-mono text-xs text-info-fg">{row.original.user_name}</span>,
      filterFn: exactArrayFilter,
    },
    { accessorKey: "account", header: t("col.account"), cell: ({ row }) => mono(row.original.account, "text-muted-foreground") },
    { accessorKey: "partition", header: t("col.partition"), cell: ({ row }) => mono(row.original.partition), filterFn: exactArrayFilter },
    {
      id: "state",
      accessorFn: (j) => j.job_state,
      header: t("col.jobState"),
      cell: ({ row }) => <JobStateBadge state={row.original.job_state} />,
      filterFn: exactArrayFilter,
    },
    {
      id: "reason",
      accessorFn: (j) => j.state_reason,
      header: t("col.reason"),
      cell: ({ row }) => <span className="text-xs text-muted-foreground">{reasonLabel(t, row.original.state_reason)}</span>,
    },
    { accessorKey: "node_count", header: t("col.nodes"), cell: ({ row }) => <span className="tnum font-mono text-xs">{row.original.node_count}</span> },
    { accessorKey: "cpus", header: t("col.cpus"), cell: ({ row }) => <span className="tnum font-mono text-xs">{row.original.cpus}</span> },
    { accessorKey: "gpus", header: t("col.gpus"), cell: ({ row }) => <span className="tnum font-mono text-xs">{row.original.gpus || "—"}</span> },
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
