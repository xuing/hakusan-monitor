import { useMemo, useState, type ReactNode } from "react";
import type { ResourceFilter } from "@/lib/slurm";
import { FilterContext } from "./resource-filter-context";

/** Shared "resource type" lens (All | CPU | a GPU type) for the monitor pages. */
export function ResourceFilterProvider({ children }: { children: ReactNode }) {
  const [filter, setFilter] = useState<ResourceFilter>("all");
  const value = useMemo(() => ({ filter, setFilter }), [filter]);
  return <FilterContext.Provider value={value}>{children}</FilterContext.Provider>;
}
