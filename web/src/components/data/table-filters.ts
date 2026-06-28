import type { Row } from "@tanstack/react-table";

export function exactArrayFilter<T>(row: Row<T>, columnId: string, filterValue: unknown) {
  const selected = Array.isArray(filterValue)
    ? filterValue.map(String)
    : filterValue
      ? [String(filterValue)]
      : [];
  if (selected.length === 0) return true;
  return selected.includes(String(row.getValue(columnId) ?? ""));
}
