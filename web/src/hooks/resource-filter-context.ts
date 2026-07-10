import { createContext, useContext } from "react";
import type { ResourceFilter } from "@/lib/slurm";

export interface FilterValue {
  filter: ResourceFilter;
  setFilter: (filter: ResourceFilter) => void;
}

export const FilterContext = createContext<FilterValue | null>(null);

export function useResourceFilter(): FilterValue {
  const ctx = useContext(FilterContext);
  if (!ctx) throw new Error("useResourceFilter must be used within ResourceFilterProvider");
  return ctx;
}
