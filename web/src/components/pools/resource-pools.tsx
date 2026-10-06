// The Overview's pool section: one card per hardware pool, grouped GPU / CPU,
// plus hardware no partition reaches.
import { useState } from "react";
import { ChevronRight, ExternalLink } from "lucide-react";
import { POOL_DOT } from "@/components/common/pool-tone";
import { Card, CardContent } from "@/components/ui/card";
import { useLive } from "@/hooks/live-context";
import { useResourceFilter } from "@/hooks/resource-filter-context";
import { useT, type TFn } from "@/i18n";
import { nf } from "@/lib/format";
import { poolTone, type PoolTone } from "@/lib/pool-status";
import { getSite } from "@/lib/site";
import { matchPool } from "@/lib/slurm";
import { cn } from "@/lib/utils";
import type { Pool, Snapshot } from "@/types/snapshot";
import { PoolCard } from "@/components/pools/pool-card";

export function ResourcePools() {
  const { snap } = useLive();
  const { filter } = useResourceFilter();
  const t = useT();
  if (!snap) return null;
  const pools = snap.pools
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => matchPool(p, filter))
    .sort((a, b) => Number(!!a.p.gpu?.maint) - Number(!!b.p.gpu?.maint) || a.i - b.i)
    .map(({ p }) => p);
  const groups = [
    { key: "gpu", label: t("kpi.gpu"), pools: pools.filter((p) => p.kind === "gpu") },
    { key: "cpu", label: t("kpi.cpu"), pools: pools.filter((p) => p.kind === "cpu") },
  ].filter((g) => g.pools.length > 0);

  return (
    <div>
      <div className="space-y-5">
        {groups.map((g) => (
          <PoolGroup
            key={g.key}
            groupKey={g.key}
            label={g.label}
            pools={g.pools}
            snap={snap}
            t={t}
            outside={filter === "all" ? (snap.outside_nodes ?? []).filter((o) => (o.gpus > 0) === (g.key === "gpu")) : []}
          />
        ))}
      </div>
    </div>
  );
}

function PoolGroup({ groupKey, label, pools, snap, t, outside = [] }: {
  groupKey: string;
  label: string;
  pools: Pool[];
  snap: Snapshot;
  t: TFn;
  /** hardware of this kind no partition reaches: a gray card, not counted */
  outside?: NonNullable<Snapshot["outside_nodes"]>;
}) {
  const tones = pools.map((p) => poolTone(snap, p));
  const available = tones.filter((tone) => tone === "ok").length;
  const groupTone: PoolTone = tones.every((tone) => tone === "off") ? "off" : available > 0 ? "ok" : "bad";
  // collapsed groups stay collapsed for this viewer
  const storeKey = `hm_pool_group_${groupKey}`;
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(storeKey) !== "closed";
    } catch {
      return true;
    }
  });
  const toggle = () => {
    setOpen(!open);
    try {
      localStorage.setItem(storeKey, open ? "closed" : "open");
    } catch {
      /* storage unavailable: the choice lasts this visit */
    }
  };
  return (
    <section className="space-y-2">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex w-full flex-wrap items-center gap-2 border-b border-border pb-1.5 text-left hover:text-foreground"
      >
        <ChevronRight className={cn("h-3.5 w-3.5 text-muted-foreground transition-transform", open && "rotate-90")} />
        <span className={cn("h-2.5 w-2.5 rounded-full", POOL_DOT[groupTone])} />
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
        <span className="font-mono text-xs text-muted-foreground">
          {available}/{pools.length} {t("part.available")}
        </span>
      </button>
      {open && <div className={cn("grid gap-4", pools.length + outside.length > 1 && "lg:grid-cols-2")}>
        {pools.map((p) => (
          <PoolCard key={p.id} pool={p} snap={snap} t={t} />
        ))}
        {outside.map((o) => <OutsideCard key={o.pool} o={o} t={t} />)}
      </div>}
    </section>
  );
}

/** Hardware scontrol lists but no partition schedules: where it would sit,
 *  grayed, saying why it cannot be used from here. */
function OutsideCard({ o, t }: { o: NonNullable<Snapshot["outside_nodes"]>[number]; t: TFn }) {
  const outsideUrl = getSite().links.outside_hardware;
  return (
    <Card className="border-dashed bg-muted/30">
      <CardContent className="space-y-2 p-4">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="h-2.5 w-2.5 self-center rounded-full bg-muted-foreground/45" />
          <span className="font-semibold text-muted-foreground">{o.label || o.pool}</span>
          <span className="text-xs text-muted-foreground">
            {o.nodes} {t("spec.nodes")}{o.gpus ? ` · ${nf(o.gpus)} ${t("unit.gpu")}` : ""}
          </span>
        </div>
        <p className="text-sm text-muted-foreground">{t("pool.outsideCard")}</p>
        {outsideUrl && (
          <a
            href={outsideUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs text-info-fg hover:underline"
          >
            {t("pool.outsideLink")}
            <ExternalLink aria-hidden className="h-3 w-3" />
          </a>
        )}
      </CardContent>
    </Card>
  );
}
