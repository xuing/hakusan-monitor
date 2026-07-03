import type { Row, Table } from "@tanstack/react-table";
import type { TFn } from "@/i18n";
import type { Snapshot } from "@/types/snapshot";

/** "All GPU" / "All CPU" quick-select bundles for the resource/pool facets. The
 * "cpu" sentinel is the jobs page's fallback pool for jobs outside every pool. */
export function poolKindGroups(snap: Snapshot, t: TFn) {
  const ids = (kind: string) => snap.pools.filter((p) => p.kind === kind).map((p) => p.id);
  return [
    { label: t("jobs.groupAll.gpu"), values: ids("gpu") },
    { label: t("jobs.groupAll.cpu"), values: [...ids("cpu"), "cpu"] },
  ];
}

export function exactArrayFilter<T>(row: Row<T>, columnId: string, filterValue: unknown) {
  const selected = normalizeFilter(filterValue);
  if (selected.length === 0) return true;
  const raw = row.getValue(columnId);
  const values = Array.isArray(raw) ? raw.map(String) : [String(raw ?? "")];
  return selected.some((value) => values.includes(value));
}

/** Like exactArrayFilter, but the cell value is a comma-joined list
 * (e.g. a job's "GPU-1,GPU-S" partition string): match any member,
 * and still accept the joined string itself (cell-click filters). */
export function commaArrayFilter<T>(row: Row<T>, columnId: string, filterValue: unknown) {
  const selected = normalizeFilter(filterValue);
  if (selected.length === 0) return true;
  const raw = String(row.getValue(columnId) ?? "");
  const values = raw.split(",").filter(Boolean);
  return selected.some((value) => value === raw || values.includes(value));
}

export function setSingleFacet<T>(table: Table<T>, columnId: string, value: string) {
  const column = table.getColumn(columnId);
  if (!column) return;
  const selected = normalizeFilter(column.getFilterValue());
  column.setFilterValue(selected.length === 1 && selected[0] === value ? undefined : [value]);
}

export function normalizeFilter(value: unknown) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (value && typeof value === "object" && Array.isArray((value as { values?: unknown }).values)) {
    return (value as { values: unknown[] }).values.map(String).filter(Boolean);
  }
  return value ? [String(value)] : [];
}
