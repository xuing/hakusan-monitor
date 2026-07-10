import { SectionCard } from "@/components/common/section-card";
import { Tag } from "@/components/common/tag";
import { AllocCell, StateBadges } from "@/components/data/cells";
import { useLive } from "@/hooks/live-context";
import { useResourceFilter } from "@/hooks/resource-filter-context";
import { useT } from "@/i18n";
import type { TranslationKey } from "@/i18n/en";
import { nodesForPool } from "@/lib/derive";
import { fmtMB } from "@/lib/format";
import type { Tone } from "@/lib/slurm";
import type { RawNode } from "@/types/snapshot";

const BUCKET_TONE: Record<string, Tone> = {
  idle: "ok",
  mixed: "warn",
  allocated: "info",
  down: "bad",
  drain: "bad",
  reserved: "neutral",
};
const BUCKET_ORDER = ["idle", "mixed", "allocated", "down", "drain", "reserved"];

/** Detailed node breakdown for the selected pool (only shown when filtered). */
export function PoolDetail() {
  const { snap } = useLive();
  const { filter } = useResourceFilter();
  const t = useT();
  if (!snap || filter === "all") return null;
  const pool = snap.pools.find((p) => p.id === filter);
  if (!pool) return null;

  const nodes = nodesForPool(snap, filter);
  const descKey = `pooldesc.${filter}` as TranslationKey;
  const desc = t(descKey);
  const coresPerNode = nodes[0]?.cpus ?? Math.round(pool.cores.total / Math.max(1, pool.nodes));
  const gpuPerNode = pool.gpu ? Math.round(pool.gpu.total / Math.max(1, pool.nodes)) : 0;

  return (
    <SectionCard title={t("section.poolDetail")}>
      {desc !== descKey && <p className="mb-3 text-sm text-muted-foreground">{desc}</p>}

      <div className="mb-3 flex flex-wrap gap-1.5">
        {BUCKET_ORDER.filter((b) => pool.nodes_state[b]).map((b) => (
          <Tag key={b} tone={BUCKET_TONE[b]}>
            {t(`state.${b}` as TranslationKey)} {pool.nodes_state[b]}
          </Tag>
        ))}
      </div>

      <div className="mb-4 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        <Spec label={t("spec.nodes")} value={String(pool.nodes)} />
        <Spec label={t("spec.cores")} value={String(coresPerNode)} />
        <Spec label={t("spec.mem")} value={fmtMB(pool.mem_per_node)} />
        {pool.gpu && <Spec label={t("spec.gpu")} value={`${gpuPerNode}× ${pool.gpu.label}`} />}
      </div>

      <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {t("section.poolNodes")} ({nodes.length})
      </div>
      <div className="max-h-80 space-y-1 overflow-y-auto pr-1">
        {nodes.map((n) => (
          <NodeRow key={n.name} n={n} />
        ))}
      </div>
    </SectionCard>
  );
}

function NodeRow({ n }: { n: RawNode }) {
  return (
    <div className="flex items-center gap-3 rounded-md bg-muted/40 px-2.5 py-1.5 text-xs">
      <span className="w-32 shrink-0 truncate font-mono">{n.name}</span>
      <StateBadges states={n.state} />
      <div className="ml-auto shrink-0">
        <AllocCell a={n.alloc_cpus} total={n.cpus} />
      </div>
    </div>
  );
}

const Spec = ({ label, value }: { label: string; value: string }) => (
  <div>
    <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
    <div className="font-mono text-sm">{value}</div>
  </div>
);
