import { Fragment, useState, type ReactNode } from "react";
import {
  flexRender,
  getCoreRowModel,
  getExpandedRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type ColumnFiltersState,
  type ExpandedState,
  type SortingState,
  type VisibilityState,
} from "@tanstack/react-table";
import { ArrowUpDown, ChevronLeft, ChevronRight, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useT } from "@/i18n";
import { cn } from "@/lib/utils";

interface DataTableProps<T> {
  columns: ColumnDef<T>[];
  data: T[];
  /** column ids hidden by default (toggleable in the Columns menu) */
  initialHidden?: string[];
  pageSize?: number;
  /** left-aligned slot in the toolbar (e.g. quick filters) */
  toolbar?: ReactNode;
  /** one-click filter chips that set the search term */
  quickFilters?: { label: string; value: string }[];
  /** column-bound multi-select filters shown in the table toolbar */
  facetFilters?: FacetFilter[];
  /** when provided, each row is expandable and this renders its detail panel */
  renderSubRow?: (row: T) => ReactNode;
}

interface FacetFilter {
  columnId: string;
  title: string;
  options: { label: string; value: string; count?: number }[];
}

export function DataTable<T>({
  columns,
  data,
  initialHidden = [],
  pageSize = 25,
  toolbar,
  quickFilters,
  facetFilters,
  renderSubRow,
}: DataTableProps<T>) {
  const t = useT();
  const [sorting, setSorting] = useState<SortingState>([]);
  const [globalFilter, setGlobalFilter] = useState("");
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [expanded, setExpanded] = useState<ExpandedState>({});
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(
    Object.fromEntries(initialHidden.map((id) => [id, false])),
  );

  const allColumns: ColumnDef<T>[] = renderSubRow
    ? [
        {
          id: "_expander",
          header: () => null,
          enableHiding: false,
          cell: ({ row }) => (
            <button
              type="button"
              aria-label="Toggle row details"
              onClick={(e) => {
                e.stopPropagation();
                row.toggleExpanded();
              }}
              className="flex text-muted-foreground hover:text-foreground"
            >
              <ChevronRight className={cn("h-4 w-4 transition-transform", row.getIsExpanded() && "rotate-90")} />
            </button>
          ),
        },
        ...columns,
      ]
    : columns;

  const table = useReactTable({
    data,
    columns: allColumns,
    state: { sorting, globalFilter, columnFilters, columnVisibility, expanded },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    onColumnFiltersChange: setColumnFilters,
    onColumnVisibilityChange: setColumnVisibility,
    onExpandedChange: setExpanded,
    getRowCanExpand: () => !!renderSubRow,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize } },
  });

  const shown = table.getFilteredRowModel().rows.length;
  const hasFilters = !!globalFilter || columnFilters.length > 0;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          placeholder={t("table.search")}
          value={globalFilter}
          onChange={(e) => setGlobalFilter(e.target.value)}
          className="h-9 max-w-xs"
        />
        {quickFilters?.map((qf) => (
          <button
            key={qf.value}
            type="button"
            onClick={() => setGlobalFilter(globalFilter === qf.value ? "" : qf.value)}
            className={cn(
              "rounded-full border px-3 py-1 text-xs transition-colors",
              globalFilter === qf.value
                ? "border-primary bg-primary font-medium text-primary-foreground"
                : "border-border text-muted-foreground hover:text-foreground",
            )}
          >
            {qf.label}
          </button>
        ))}
        {facetFilters?.map((filter) => {
          const column = table.getColumn(filter.columnId);
          if (!column) return null;
          return <FacetFilterControl key={filter.columnId} filter={filter} value={column.getFilterValue()} onChange={(value) => column.setFilterValue(value.length ? value : undefined)} />;
        })}
        {hasFilters && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 px-2 text-xs text-muted-foreground"
            onClick={() => {
              setGlobalFilter("");
              setColumnFilters([]);
            }}
          >
            {t("table.reset")}
          </Button>
        )}
        {toolbar}
        <div className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
          <span className="tnum">{t("table.showing", { n: shown, total: data.length })}</span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-8 gap-1.5">
                <Settings2 className="h-3.5 w-3.5" />
                {t("table.columns")}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-80 overflow-y-auto">
              {table
                .getAllColumns()
                .filter((c) => c.getCanHide())
                .map((c) => (
                  <DropdownMenuCheckboxItem
                    key={c.id}
                    checked={c.getIsVisible()}
                    onCheckedChange={(v) => c.toggleVisibility(!!v)}
                    onSelect={(e) => e.preventDefault()}
                  >
                    {typeof c.columnDef.header === "string" ? c.columnDef.header : c.id}
                  </DropdownMenuCheckboxItem>
                ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-border">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              {table.getHeaderGroups().map((hg) => (
                <TableRow key={hg.id} className="hover:bg-transparent">
                  {hg.headers.map((h) => (
                    <TableHead key={h.id} className="whitespace-nowrap">
                      {h.isPlaceholder ? null : h.column.getCanSort() ? (
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 hover:text-foreground"
                          onClick={h.column.getToggleSortingHandler()}
                        >
                          {flexRender(h.column.columnDef.header, h.getContext())}
                          <ArrowUpDown className="h-3 w-3 opacity-40" />
                        </button>
                      ) : (
                        flexRender(h.column.columnDef.header, h.getContext())
                      )}
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {table.getRowModel().rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={allColumns.length} className="h-24 text-center text-muted-foreground">
                    {t("table.noresults")}
                  </TableCell>
                </TableRow>
              ) : (
                table.getRowModel().rows.map((row) => (
                  <Fragment key={row.id}>
                    <TableRow
                      className={cn(renderSubRow && "cursor-pointer")}
                      onClick={renderSubRow ? row.getToggleExpandedHandler() : undefined}
                    >
                      {row.getVisibleCells().map((cell) => (
                        <TableCell key={cell.id} className="whitespace-nowrap">
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </TableCell>
                      ))}
                    </TableRow>
                    {row.getIsExpanded() && renderSubRow && (
                      <TableRow className="hover:bg-transparent">
                        <TableCell colSpan={allColumns.length} className="bg-muted/30 p-0">
                          {renderSubRow(row.original)}
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      {table.getPageCount() > 1 && (
        <div className="flex items-center justify-end gap-2 text-xs text-muted-foreground">
          <span className="tnum">
            {table.getState().pagination.pageIndex + 1} / {table.getPageCount()}
          </span>
          <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => table.nextPage()} disabled={!table.getCanNextPage()}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  );
}

function FacetFilterControl({
  filter,
  value,
  onChange,
}: {
  filter: FacetFilter;
  value: unknown;
  onChange: (value: string[]) => void;
}) {
  const selected = new Set(Array.isArray(value) ? value.map(String) : []);
  const selectedLabels = filter.options
    .filter((option) => selected.has(option.value))
    .map((option) => option.label);
  const label = selectedLabels.length === 0
    ? filter.title
    : selectedLabels.length === 1
      ? selectedLabels[0]
      : `${filter.title} ${selectedLabels.length}`;

  const toggle = (optionValue: string) => {
    const next = new Set(selected);
    if (next.has(optionValue)) next.delete(optionValue);
    else next.add(optionValue);
    onChange([...next]);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant={selected.size ? "default" : "outline"} size="sm" className="h-8 gap-1.5">
          <span className="max-w-[10rem] truncate">{label}</span>
          {selected.size > 0 && <span className="rounded bg-background/20 px-1 font-mono text-[10px]">{selected.size}</span>}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 min-w-48 overflow-y-auto">
        {filter.options.map((option) => (
          <DropdownMenuCheckboxItem
            key={option.value}
            checked={selected.has(option.value)}
            onCheckedChange={() => toggle(option.value)}
            onSelect={(e) => e.preventDefault()}
          >
            <span className="min-w-0 flex-1 truncate">{option.label}</span>
            {option.count !== undefined && <span className="ml-3 font-mono text-[10px] text-muted-foreground">{option.count}</span>}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
