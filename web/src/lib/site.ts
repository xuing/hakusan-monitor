// The site this dashboard runs for (GET /api/site): its name, links, page
// switches, partition order and its own text, merged over the built-in
// dictionaries. Nothing here is required — a cluster without a site file gets
// Slurm's ClusterName, slurm.conf partition order and the generic text.
import { DICTS, LANGS, type Lang } from "@/i18n/core";
import { withBase } from "@/lib/base-path";
import { fmtMB } from "@/lib/format";
import type { Pool } from "@/types/snapshot";

/** How people reach the cluster (the Getting started page). */
export interface SiteAccess {
  /** login nodes to ssh to; `id` matches the login-node monitor's ids */
  login_hosts: { id: string; host: string }[];
  /** a domain the local network appends to a short host name (DNS search
   *  list): commands then use `hakusan1` for `hakusan1.example.ac.jp` */
  search_domain?: string;
  /** a user name of the site's form, shown until the reader types theirs */
  user_example: string;
}

export interface SiteInfo {
  cluster: string;
  name: string;
  org: string;
  links: { home?: string; outside_hardware?: string };
  pages: { slurm_guide: boolean; containers?: boolean; getting_started?: boolean };
  access?: SiteAccess;
  partition_order: string[];
  /** partition of the Containers page's interactive example ("" = Slurm's default) */
  container_shell_partition?: string;
  /** IANA zone Slurm prints its times in (HM_CLUSTER_TZ); "" = unknown */
  time_zone?: string;
  strings: Partial<Record<Lang, Record<string, string>>>;
}

const DEFAULT_SITE: SiteInfo = {
  cluster: "slurm",
  name: "Slurm",
  org: "",
  links: {},
  pages: { slurm_guide: false },
  partition_order: [],
  strings: {},
};

type Dict = Record<string, string>;
// the dictionaries as built, so applying a site twice starts from the same text
const BASE: Record<Lang, Dict> = Object.fromEntries(
  LANGS.map((lang) => [lang, { ...(DICTS[lang] as Dict) }]),
) as Record<Lang, Dict>;

let site: SiteInfo = DEFAULT_SITE;

/** window event after a late site load; the i18n provider re-renders on it */
export const SITE_LOADED_EVENT = "hm-site-loaded";
let partitionRank = new Map<string, number>();

export const getSite = () => site;

/** Merge the site's strings over the built-in ones and fill {siteName},
 *  {cluster} and {org} in every string. */
export function applySite(next: SiteInfo) {
  site = { ...DEFAULT_SITE, ...next, links: next.links ?? {}, pages: { ...DEFAULT_SITE.pages, ...next.pages } };
  for (const lang of LANGS) {
    const merged: Dict = { ...BASE[lang], ...(site.strings[lang] ?? {}) };
    for (const key in merged) {
      merged[key] = merged[key]
        .replaceAll("{siteName}", site.name)
        .replaceAll("{cluster}", site.cluster)
        .replaceAll("{org}", site.org);
    }
    const dict = DICTS[lang] as Dict;
    for (const key of Object.keys(dict)) delete dict[key];
    Object.assign(dict, merged);
  }
  setPartitionOrder(site.partition_order);
}

export function setPartitionOrder(order: string[] | undefined) {
  if (!order?.length) return;
  partitionRank = new Map(order.map((name, i) => [name, i]));
}

/** Position in the site's partition order (slurm.conf order without a site
 *  file); unknown partitions sort after every known one. */
export function partitionOrderRank(name: string | null | undefined) {
  return partitionRank.get(String(name || "").split(",")[0]) ?? partitionRank.size;
}

/** Name pools the site file doesn't: a GPU pool by its GPU model, a CPU pool
 *  by its node shape — just "CPU" when it is the only one, the core count
 *  when that tells it apart, else cores and memory. */
export function registerPoolLabels(pools: Pool[]) {
  const shapes = pools.flatMap((pool) => {
    const m = pool.id.match(/^cpu-(\d+)c-(\d+)g(?:-auto)?$/);
    return m ? [{ id: pool.id, cores: m[1] }] : [];
  });
  const sameCores = (cores: string) => shapes.filter((s) => s.cores === cores).length;
  for (const pool of pools) {
    const key = `pool.${pool.id}`;
    const shape = shapes.find((s) => s.id === pool.id);
    for (const lang of LANGS) {
      const dict = DICTS[lang] as Dict;
      if (key in dict && !autoLabels.has(key)) continue;
      const cores = shape && `${shape.cores} ${dict["unit.cores"] ?? "cores"}`;
      const label = shape
        ? shapes.length === 1 ? "CPU"
          : sameCores(shape.cores) === 1 ? `CPU · ${cores}` : `CPU · ${cores} · ${fmtMB(pool.mem_per_node)}`
        : pool.gpu?.label;
      if (!label) continue;
      dict[key] = label;
      autoLabels.add(key);
    }
  }
}
const autoLabels = new Set<string>();

/** Load the site before the first render. After `timeoutMs` the page renders
 *  with the generic text, and the site is applied when it arrives
 *  (`onLate`), so a slow link costs the site text only for a moment. */
export async function loadSite(onLate: () => void, timeoutMs = 3000) {
  let late = false;
  let applied = false;
  const fetchSite = async (attempt = 0): Promise<void> => {
    try {
      const res = await fetch(withBase("/api/site"), { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(`/api/site → ${res.status}`);
      applySite(await res.json() as SiteInfo);
      applied = true;
      if (late) onLate();
    } catch {
      if (attempt < 5) {
        await new Promise((resolve) => setTimeout(resolve, 5000 * (attempt + 1)));
        return fetchSite(attempt + 1);
      }
    }
  };
  const loaded = fetchSite();
  const timedOut = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), timeoutMs));
  if (await Promise.race([loaded, timedOut]) === "timeout" && !applied) {
    late = true;
    applySite(DEFAULT_SITE);
  }
}
