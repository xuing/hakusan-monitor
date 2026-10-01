import { describe, expect, it, vi } from "vitest";
import { constructTable, tableFeatures, type ColumnDef } from "@tanstack/react-table";
import { storeReactivityBindings } from "@tanstack/table-core/store-reactivity-bindings";
import type { RawNode } from "@/types/snapshot";
import { jobIdKey } from "./columns-jobs";
import { nodeColumns } from "./columns-nodes";
import { dataTableFeatures, type DataTableFeatures } from "./table-features";
import { commaArrayFilter, exactArrayFilter, setSingleFacet } from "./table-filters";

type RecordRow = { name: string; pool: string; state: string[]; partition: string; cpus: number };
const data: RecordRow[] = [
  { name: "node10", pool: "gpu", state: ["IDLE", "DRAIN"], partition: "GPU-1,GPU-S", cpus: 52 },
  { name: "node2", pool: "gpu", state: ["ALLOCATED"], partition: "GPU-S", cpus: 26 },
  { name: "node1", pool: "cpu", state: ["IDLE"], partition: "CPU", cpus: 32 },
];
const columns: ColumnDef<DataTableFeatures, RecordRow>[] = [
  { accessorKey: "name" },
  { accessorKey: "pool", filterFn: exactArrayFilter },
  { accessorKey: "state", filterFn: exactArrayFilter },
  { accessorKey: "partition", filterFn: commaArrayFilter },
  { accessorKey: "cpus" },
];
function makeTable() {
  return constructTable({
    features: tableFeatures({ ...dataTableFeatures, coreReactivityFeature: storeReactivityBindings() }),
    data,
    columns,
    globalFilterFn: "includesString",
    initialState: { pagination: { pageIndex: 0, pageSize: 2 }, columnVisibility: { pool: false } },
    getRowCanExpand: () => true,
    autoResetPageIndex: false,
    autoResetExpanded: false,
  });
}

describe("v9 data table feature integration", () => {
  it("sorts text naturally and numbers numerically before pagination", () => {
    const table = makeTable();
    table.setSorting([{ id: "name", desc: false }]);
    expect(table.getRowModel().rows.map((row) => row.original.name)).toEqual(["node1", "node2"]);
    table.setSorting([{ id: "cpus", desc: true }]);
    expect(table.getRowModel().rows.map((row) => row.original.cpus)).toEqual([52, 32]);
    table.lastPage();
    expect(table.getRowModel().rows.map((row) => row.original.cpus)).toEqual([26]);
    expect(table.getCanNextPage()).toBe(false);
    table.firstPage();
    expect(table.getCanPreviousPage()).toBe(false);
  });

  it("keeps the node state and partition comparator based on their first member", () => {
    const node = (name: string, state: string[], partitions: string[]): RawNode => ({
      name, state, partitions, pool: "gpu", state_bucket: "idle", schedulable: true,
      cpus: 52, alloc_cpus: 0, cpu_load: "0", real_memory: 1024, alloc_memory: 0,
      free_mem: 1024, gres: "", gres_used: "", features: "", alloc_tres: "",
      cfg_tres: "", boot_time: "", reason: "",
    });
    const table = constructTable({
      features: tableFeatures({ ...dataTableFeatures, coreReactivityFeature: storeReactivityBindings() }),
      columns: nodeColumns((key) => key),
      data: [node("a", ["IDLE", "Z"], ["GPU-S", "A"]), node("b", ["ALLOCATED"], ["GPU-1", "Z"])],
    });
    table.setSorting([{ id: "state", desc: false }]);
    expect(table.getRowModel().rows.map((row) => row.original.name)).toEqual(["b", "a"]);
    table.setSorting([{ id: "partitions", desc: true }]);
    expect(table.getRowModel().rows.map((row) => row.original.name)).toEqual(["a", "b"]);
  });

  it("combines global search with exact scalar and array filters, including hidden columns", () => {
    const table = makeTable();
    table.setGlobalFilter("GPU");
    table.getColumn("state")?.setFilterValue(["IDLE"]);
    expect(table.getFilteredRowModel().rows.map((row) => row.original.name)).toEqual(["node10"]);
    table.getColumn("state")?.setFilterValue({ values: ["ALLOCATED", "DRAIN"] });
    expect(table.getFilteredRowModel().rows).toHaveLength(2);
    table.setGlobalFilter("NODE2");
    expect(table.getFilteredRowModel().rows.map((row) => row.original.name)).toEqual(["node2"]);
    table.setGlobalFilter("26");
    expect(table.getFilteredRowModel().rows.map((row) => row.original.name)).toEqual(["node2"]);
  });

  it("matches comma-separated members and the whole cell-click value, then toggles it off", () => {
    const table = makeTable();
    table.getColumn("partition")?.setFilterValue(["GPU-S"]);
    expect(table.getFilteredRowModel().rows).toHaveLength(2);
    setSingleFacet(table, "partition", "GPU-1,GPU-S");
    expect(table.getFilteredRowModel().rows.map((row) => row.original.name)).toEqual(["node10"]);
    setSingleFacet(table, "partition", "GPU-1,GPU-S");
    expect(table.getFilteredRowModel().rows).toHaveLength(3);
    table.getColumn("state")?.setFilterValue([]);
    expect(table.getFilteredRowModel().rows).toHaveLength(3);
  });

  it("facets exclude their own filter and include other column filters and global search", () => {
    const table = makeTable();
    table.getColumn("pool")?.setFilterValue(["gpu"]);
    expect(table.getColumn("pool")?.getFacetedUniqueValues()).toEqual(new Map([["gpu", 2], ["cpu", 1]]));
    table.getColumn("state")?.setFilterValue(["IDLE"]);
    expect(table.getColumn("pool")?.getFacetedUniqueValues()).toEqual(new Map([["gpu", 1], ["cpu", 1]]));
    expect(table.getColumn("partition")?.getFacetedRowModel().flatRows.map((row) => row.original.partition)).toEqual(["GPU-1,GPU-S"]);
    table.setGlobalFilter("node10");
    expect(table.getColumn("pool")?.getFacetedUniqueValues()).toEqual(new Map([["gpu", 1]]));
  });

  it("updates visible headers and cells while preserving expansion and page on snapshot refresh", async () => {
    const table = makeTable();
    expect(table.getRowModel().rows[0].getVisibleCells().map((cell) => cell.column.id)).not.toContain("pool");
    table.getColumn("pool")?.toggleVisibility(true);
    expect(table.getHeaderGroups()[0].headers.map((header) => header.column.id)).toContain("pool");
    expect(table.getRowModel().rows[0].getVisibleCells().map((cell) => cell.column.id)).toContain("pool");
    table.getRowModel().rows[0].toggleExpanded();
    table.nextPage();
    table.setOptions((previous) => ({ ...previous, data: data.map((row) => ({ ...row })) }));
    table.getRowModel();
    await Promise.resolve();
    expect(table.atoms.pagination.get().pageIndex).toBe(1);
    expect(table.getCoreRowModel().rows[0].getIsExpanded()).toBe(true);
  });

  it("resolves every automatic filter and sort without missing-registry warnings on empty data", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const table = makeTable();
      for (const column of table.getAllLeafColumns()) {
        expect(column.getFilterFn()).toBeTypeOf("function");
        expect(column.getSortFn()).toBeTypeOf("function");
      }
      table.setOptions((previous) => ({ ...previous, data: [] }));
      for (const column of table.getAllLeafColumns()) {
        expect(column.getFilterFn()).toBeTypeOf("function");
        expect(column.getSortFn()).toBeTypeOf("function");
      }
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});


describe("job ID ordering", () => {
  it("orders mixed numeric and array-task IDs by job number, then task", () => {
    const ids: (string | number)[] = ["759320_10", 141962, "759320_7", 141411, "141411_2"];
    const sorted = [...ids].sort((a, b) => {
      const [aj, at] = jobIdKey(a);
      const [bj, bt] = jobIdKey(b);
      return aj - bj || at - bt;
    });
    expect(sorted).toEqual([141411, "141411_2", 141962, "759320_7", "759320_10"]);
  });
});
