import type { ColumnDef, SortingFn } from "@tanstack/react-table";
import { poolLabel, type TFn } from "@/i18n";
import { fmtAt, fmtMB } from "@/lib/format";
import type { RawNode } from "@/types/snapshot";
import { AllocCell, StateBadges } from "./cells";
import { exactArrayFilter, setSingleFacet } from "./table-filters";

const mono = (v: string) => <span className="font-mono text-xs">{v || "—"}</span>;
const muted = (v: string) => <span className="text-xs text-muted-foreground">{v || "—"}</span>;
const firstStringSort: SortingFn<RawNode> = (a, b, columnId) => {
  const av = a.getValue<string[] | string>(columnId);
  const bv = b.getValue<string[] | string>(columnId);
  const as = Array.isArray(av) ? av[0] : av;
  const bs = Array.isArray(bv) ? bv[0] : bv;
  return String(as ?? "").localeCompare(String(bs ?? ""));
};

export function nodeColumns(t: TFn): ColumnDef<RawNode>[] {
  return [
    {
      accessorKey: "name",
      header: t("col.node"),
      cell: ({ row }) => <span className="font-mono font-medium">{row.original.name}</span>,
    },
    {
      id: "pool",
      accessorFn: (n) => n.pool,
      header: t("jobs.filter.resource"),
      cell: ({ row, table }) => (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setSingleFacet(table, "pool", row.original.pool);
          }}
          className="rounded px-1 py-0.5 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          {poolLabel(t, row.original.pool)}
        </button>
      ),
      filterFn: exactArrayFilter,
    },
    {
      id: "state",
      accessorFn: (n) => n.state,
      header: t("col.state"),
      cell: ({ row, table }) => <StateBadges states={row.original.state} onSelect={(state) => setSingleFacet(table, "state", state)} />,
      filterFn: exactArrayFilter,
      sortingFn: firstStringSort,
    },
    {
      id: "partitions",
      accessorFn: (n) => n.partitions,
      header: t("col.partitions"),
      cell: ({ row }) => (
        <span className="tnum text-xs text-muted-foreground" title={row.original.partitions.join(", ")}>
          {row.original.partitions.length}
        </span>
      ),
      filterFn: exactArrayFilter,
      sortingFn: firstStringSort,
    },
    {
      id: "cpus",
      accessorFn: (n) => n.alloc_cpus,
      header: t("col.cpusAlloc"),
      cell: ({ row }) => <AllocCell a={row.original.alloc_cpus} total={row.original.cpus} />,
    },
    {
      id: "load",
      accessorFn: (n) => parseFloat(n.cpu_load) || 0,
      header: t("col.cpuLoad"),
      cell: ({ getValue }) => <span className="tnum font-mono text-xs">{getValue<number>().toFixed(0)}</span>,
    },
    {
      id: "mem",
      accessorFn: (n) => n.alloc_memory,
      header: t("col.memUsed"),
      cell: ({ row }) => (
        <span className="font-mono text-xs">
          {fmtMB(row.original.alloc_memory)} / {fmtMB(row.original.real_memory)}
        </span>
      ),
    },
    {
      id: "freemem",
      accessorFn: (n) => n.free_mem,
      header: t("col.memFree"),
      cell: ({ getValue }) => <span className="font-mono text-xs">{fmtMB(getValue<number>())}</span>,
    },
    { accessorKey: "gres", header: t("col.gpu"), cell: ({ row }) => mono(row.original.gres) },
    { accessorKey: "gres_used", header: t("col.gpuUsed"), cell: ({ row }) => muted(row.original.gres_used) },
    { accessorKey: "features", header: t("col.features"), cell: ({ row }) => muted(row.original.features) },
    {
      accessorKey: "boot_time",
      header: t("col.boot"),
      cell: ({ row }) => <span className="font-mono text-xs text-muted-foreground">{row.original.boot_time ? fmtAt(row.original.boot_time) : "—"}</span>,
    },
    { accessorKey: "reason", header: t("col.reason"), cell: ({ row }) => muted(row.original.reason) },
    { accessorKey: "cfg_tres", header: "CfgTRES", cell: ({ row }) => muted(row.original.cfg_tres) },
    { accessorKey: "alloc_tres", header: "AllocTRES", cell: ({ row }) => muted(row.original.alloc_tres) },
  ];
}

export const NODE_HIDDEN = ["pool", "features", "boot_time", "cfg_tres", "alloc_tres", "gres_used"];
