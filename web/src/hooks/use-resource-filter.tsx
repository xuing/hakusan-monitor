import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import type { ResourceFilter } from "@/lib/slurm";

interface FilterValue {
  filter: ResourceFilter;
  setFilter: (f: ResourceFilter) => void;
}

const FilterContext = createContext<FilterValue | null>(null);

/** Shared "resource type" lens (All | CPU | a GPU type) for the monitor pages. */
export function ResourceFilterProvider({ children }: { children: ReactNode }) {
  const [filter, setFilter] = useState<ResourceFilter>("all");
  const value = useMemo(() => ({ filter, setFilter }), [filter]);
  return <FilterContext.Provider value={value}>{children}</FilterContext.Provider>;
}

export function useResourceFilter(): FilterValue {
  const ctx = useContext(FilterContext);
  if (!ctx) throw new Error("useResourceFilter must be used within ResourceFilterProvider");
  return ctx;
}
