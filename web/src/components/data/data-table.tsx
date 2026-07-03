import { Fragment, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import {
  flexRender,
  getCoreRowModel,
  getExpandedRowModel,
  getFacetedRowModel,
  getFacetedUniqueValues,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type ColumnFiltersState,
  type ExpandedState,
  type PaginationState,
  type SortingState,
  type Table as TanStackTable,
  type VisibilityState,
} from "@tanstack/react-table";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Columns3,
  Search,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuSeparator,
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
import { normalizeFilter } from "./table-filters";

export interface DataFacet<T> {
  columnId: string;
  label: string;
  valueLabel?: (value: string) => string;
  valuesFromRow?: (row: T) => string[];
  /** Quick-select bundles shown above the value list (e.g. "All GPU" -> every GPU pool). */
  groups?: { label: string; values: string[] }[];
}

interface DataTableProps<T> {
  columns: ColumnDef<T>[];
  data: T[];
  facets?: DataFacet<T>[];
  initialHidden?: string[];
  pageSize?: number;
  renderSubRow?: (row: T) => ReactNode;
}

export function DataTable<T>({
  columns,
  data,
  facets = [],
  initialHidden = [],
  pageSize = 30,
  renderSubRow,
}: DataTableProps<T>) {
  const t = useT();
  const [sorting, setSorting] = useState<SortingState>([]);
  const [globalFilter, setGlobalFilter] = useState("");
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [expanded, setExpanded] = useState<ExpandedState>({});
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize });
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(
    Object.fromEntries(initialHidden.map((id) => [id, false])),
  );

  const allColumns = useMemo<ColumnDef<T>[]>(
    () =>
      renderSubRow
        ? [
            {
              id: "_expander",
              header: () => null,
              enableHiding: false,
              enableSorting: false,
              cell: ({ row }) => (
                <button
                  type="button"
                  aria-label="Toggle row details"
                  onClick={(e) => {
                    e.stopPropagation();
                    row.toggleExpanded();
                  }}
                  className="grid h-6 w-6 place-items-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <ChevronRight className={cn("h-4 w-4 transition-transform", row.getIsExpanded() && "rotate-90")} />
                </button>
              ),
            },
            ...columns,
          ]
        : columns,
    [columns, renderSubRow],
  );

  const table = useReactTable({
    data,
    columns: allColumns,
    state: { sorting, globalFilter, columnFilters, expanded, pagination, columnVisibility },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    onColumnFiltersChange: setColumnFilters,
    onExpandedChange: setExpanded,
    onPaginationChange: setPagination,
    onColumnVisibilityChange: setColumnVisibility,
    getRowCanExpand: () => !!renderSubRow,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
    getSortedRowModel: getSortedRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    globalFilterFn: "includesString",
    // live snapshots replace `data` every few minutes — don't yank the user
    // back to page 1 or collapse their expanded rows on each refresh
    autoResetPageIndex: false,
    autoResetExpanded: false,
  });

  const filteredCount = table.getFilteredRowModel().rows.length;
  const hasFilters = globalFilter.trim() || columnFilters.length > 0;
  const resetFilters = () => {
    setGlobalFilter("");
    setColumnFilters([]);
    setExpanded({});
    table.setPageIndex(0);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[14rem] flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder={t("table.search")}
            value={globalFilter}
            onChange={(e) => setGlobalFilter(e.target.value)}
            className="h-8 pl-8 text-sm"
          />
        </div>

        {facets.map((facet) => (
          <FacetDropdown key={facet.columnId} table={table} facet={facet} />
        ))}

        {hasFilters && (
          <Button variant="ghost" size="sm" className="h-8 px-2 text-xs text-muted-foreground" onClick={resetFilters}>
            <X className="h-3.5 w-3.5" />
            {t("table.reset")}
          </Button>
        )}

        <div className="ml-auto flex items-center gap-2">
          <span className="tnum text-xs text-muted-foreground">{t("table.showing", { n: filteredCount, total: data.length })}</span>
          <ColumnMenu table={table} />
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="max-h-[calc(100vh-260px)] overflow-auto">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-muted">
              {table.getHeaderGroups().map((headerGroup) => (
                <TableRow key={headerGroup.id} className="hover:bg-transparent">
                  {headerGroup.headers.map((header) => (
                    <TableHead key={header.id} className="h-9 whitespace-nowrap bg-muted text-[11px]">
                      {header.isPlaceholder ? null : header.column.getCanSort() ? (
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 text-left hover:text-foreground"
                          onClick={header.column.getToggleSortingHandler()}
                        >
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          <SortIcon sort={header.column.getIsSorted()} />
                        </button>
                      ) : (
                        flexRender(header.column.columnDef.header, header.getContext())
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
                        <TableCell key={cell.id} className="whitespace-nowrap py-1.5 text-xs">
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
        <div className="flex items-center justify-end gap-1.5 text-xs text-muted-foreground">
          <span className="tnum mr-1">
            {table.getState().pagination.pageIndex + 1} / {table.getPageCount()}
          </span>
          <PageButton label="First page" onClick={() => table.firstPage()} disabled={!table.getCanPreviousPage()}>
            <ChevronsLeft className="h-4 w-4" />
          </PageButton>
          <PageButton label="Previous page" onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()}>
            <ChevronLeft className="h-4 w-4" />
          </PageButton>
          <PageButton label="Next page" onClick={() => table.nextPage()} disabled={!table.getCanNextPage()}>
            <ChevronRight className="h-4 w-4" />
          </PageButton>
          <PageButton label="Last page" onClick={() => table.lastPage()} disabled={!table.getCanNextPage()}>
            <ChevronsRight className="h-4 w-4" />
          </PageButton>
        </div>
      )}
    </div>
  );
}

function FacetDropdown<T>({ table, facet }: { table: TanStackTable<T>; facet: DataFacet<T> }) {
  const t = useT();
  const column = table.getColumn(facet.columnId);
  if (!column) return null;
  const selected = normalizeFilter(column.getFilterValue());
  const selectedSet = new Set(selected);
  const options = facetOptions(table, facet);
  const visibleValues = options.map((option) => option.value);
  const valueLabel = facet.valueLabel ?? ((value: string) => value);
  const label =
    selected.length === 0
      ? facet.label
      : selected.length === 1
        ? valueLabel(selected[0])
        : `${facet.label} ${selected.length}`;

  const applySelection = (values: string[]) => {
    column.setFilterValue(values.length ? values : undefined);
    table.setPageIndex(0);
  };

  const toggle = (value: string) => {
    const next = new Set(selectedSet);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    applySelection([...next]);
  };

  const invert = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    applySelection(visibleValues.filter((value) => !selectedSet.has(value)));
  };

  const clear = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    applySelection([]);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant={selected.length ? "default" : "outline"} size="sm" className="h-8 max-w-[11rem] px-2.5">
          <span className="truncate">{label}</span>
          {selected.length > 0 && <span className="rounded bg-background/20 px-1 font-mono text-[10px]">{selected.length}</span>}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72 min-w-52">
        {options.length === 0 ? (
          <div className="px-2 py-2 text-xs text-muted-foreground">—</div>
        ) : (
          <>
            {selected.length > 0 && (
              <>
                <div className="sticky top-0 z-10 -mx-1 -mt-1 flex justify-end gap-1 bg-popover p-1">
                  <button
                    type="button"
                    className="rounded px-1.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    onClick={invert}
                  >
                    {t("table.invert")}
                  </button>
                  <button
                    type="button"
                    className="rounded px-1.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    onClick={clear}
                  >
                    {t("table.clear")}
                  </button>
                </div>
                <DropdownMenuSeparator />
              </>
            )}
            {(facet.groups ?? []).map((group) => {
              const inGroup = options.filter((o) => group.values.includes(o.value));
              if (!inGroup.length) return null;
              const allOn = inGroup.every((o) => selectedSet.has(o.value));
              return (
                <DropdownMenuCheckboxItem
                  key={group.label}
                  checked={allOn}
                  onCheckedChange={() => {
                    const next = new Set(selectedSet);
                    for (const o of inGroup) {
                      if (allOn) next.delete(o.value);
                      else next.add(o.value);
                    }
                    applySelection([...next]);
                  }}
                  onSelect={(e) => e.preventDefault()}
                  className="text-xs font-medium"
                >
                  <span className="min-w-0 flex-1 truncate">{group.label}</span>
                  <span className="ml-3 font-mono text-[10px] text-muted-foreground">
                    {inGroup.reduce((n, o) => n + o.count, 0)}
                  </span>
                </DropdownMenuCheckboxItem>
              );
            })}
            {(facet.groups ?? []).some((g) => options.some((o) => g.values.includes(o.value))) && <DropdownMenuSeparator />}
            {options.map((option) => (
              <DropdownMenuCheckboxItem
                key={option.value}
                checked={selectedSet.has(option.value)}
                onCheckedChange={() => toggle(option.value)}
                onSelect={(e) => e.preventDefault()}
                className="text-xs"
              >
                <span className="min-w-0 flex-1 truncate">{valueLabel(option.value)}</span>
                <span className="ml-3 font-mono text-[10px] text-muted-foreground">{option.count}</span>
              </DropdownMenuCheckboxItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function facetOptions<T>(table: TanStackTable<T>, facet: DataFacet<T>) {
  const column = table.getColumn(facet.columnId);
  if (!column) return [];
  const counts = new Map<string, number>();
  if (facet.valuesFromRow) {
    for (const row of column.getFacetedRowModel().flatRows) {
      for (const value of facet.valuesFromRow(row.original).map(String).filter(Boolean)) {
        counts.set(value, (counts.get(value) ?? 0) + 1);
      }
    }
  } else {
    for (const [value, count] of column.getFacetedUniqueValues().entries()) {
      const key = String(value ?? "");
      if (key) counts.set(key, Number(count));
    }
  }
  for (const value of normalizeFilter(column.getFilterValue())) {
    if (!counts.has(value)) counts.set(value, 0);
  }
  const valueLabel = facet.valueLabel ?? ((value: string) => value);
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || valueLabel(a.value).localeCompare(valueLabel(b.value)));
}

function ColumnMenu<T>({ table }: { table: TanStackTable<T> }) {
  const t = useT();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 px-2.5">
          <Columns3 className="h-3.5 w-3.5" />
          {t("table.columns")}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-72 min-w-44">
        {table
          .getAllLeafColumns()
          .filter((column) => column.getCanHide())
          .map((column) => (
            <DropdownMenuCheckboxItem
              key={column.id}
              checked={column.getIsVisible()}
              onCheckedChange={(value) => column.toggleVisibility(!!value)}
              onSelect={(e) => e.preventDefault()}
              className="text-xs"
            >
              {typeof column.columnDef.header === "string" ? column.columnDef.header : column.id}
            </DropdownMenuCheckboxItem>
          ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SortIcon({ sort }: { sort: false | "asc" | "desc" }) {
  if (sort === "asc") return <ArrowUp className="h-3 w-3 opacity-70" />;
  if (sort === "desc") return <ArrowDown className="h-3 w-3 opacity-70" />;
  return <ArrowUpDown className="h-3 w-3 opacity-35" />;
}

function PageButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button variant="outline" size="icon" className="h-7 w-7" aria-label={label} onClick={onClick} disabled={disabled}>
      {children}
    </Button>
  );
}

export type { ColumnDef };
