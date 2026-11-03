import { useMemo, useState, type ReactNode } from "react";
import { useLocation } from "react-router";
import { useHashSync } from "@/hooks/use-hash-sync";
import { useLive } from "@/hooks/live-context";
import { readHash } from "@/lib/hash-params";
import { FILTERED_PATHS } from "@/lib/nav";
import type { ResourceFilter } from "@/lib/slurm";
import { FilterContext } from "./resource-filter-context";

/** Shared "resource type" lens (All | a pool) for the monitor pages. On the
 *  pages that show it, the choice lives in the URL as `#pool=<id>`, so a link
 *  opens the same view. It carries over when the user moves between them. */
export function ResourceFilterProvider({ children }: { children: ReactNode }) {
  const { pathname, hash } = useLocation();
  const { snap } = useLive();
  const onPage = FILTERED_PATHS.has(pathname);
  const [picked, setFilter] = useState<ResourceFilter>(() => (onPage && readHash(hash).get("pool")) || "all");
  useHashSync(onPage, { pool: picked === "all" ? null : picked }, (p) => setFilter(p.get("pool") || "all"));
  // a link to a pool this cluster does not have shows everything
  const filter = snap && !snap.pools.some((p) => p.id === picked) ? "all" : picked;
  const value = useMemo(() => ({ filter, setFilter }), [filter]);
  return <FilterContext.Provider value={value}>{children}</FilterContext.Provider>;
}
