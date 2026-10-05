import { Fragment } from "react";
import { durText, poolLabel, useI18n, type TFn, type TranslationKey } from "@/i18n";
import { compactNumber, pctText, poolColor, unitHours, unitWord, waitFinding, waitText } from "@/lib/analytics-format";
import { nf } from "@/lib/format";
import type { AnalyticsMeta, AnalyticsView, WaitPartition } from "@/types/analytics";
import { AnCard, Dot, Legend, StackedBar } from "./parts";
import { rich } from "./rich";

const COLS = "6.5rem 9rem 3rem 12rem minmax(0, 1fr) 4.75rem 4.75rem";
const WAIT_KEYS = ["an.wait.b0", "an.wait.b1", "an.wait.b2", "an.wait.b3", "an.wait.b4"] as TranslationKey[];
const WAIT_INK = ["var(--an-wait-ink-0)", undefined, undefined, undefined, "var(--an-wait-ink-4)"];

function specText(t: TFn, p: WaitPartition): string {
  const size = p.max_units
    ? p.max_units === 1 ? t("an.spec.gpu1") : t("an.spec.gpuN", { n: p.max_units })
    : p.max_cores ? t("an.spec.cores", { n: nf(p.max_cores) }) : "";
  const wall = p.wall_min ? durText(t, p.wall_min * 60) : "";
  return [size, wall].filter(Boolean).join(" · ");
}

/** Per-partition scorecard: who uses it, how much, and how long jobs wait. */
export function PartitionWaits({ view, meta }: { view: AnalyticsView; meta: AnalyticsMeta }) {
  const { t, lang } = useI18n();
  const parts = view.waits.partitions;
  const maxHours = Math.max(1, ...parts.map((p) => p.unit_hours));
  const f = waitFinding(view);
  const groups = view.pools
    .map((pool, index) => ({ pool, index, rows: parts.filter((p) => p.pool === pool.id) }))
    .filter((g) => g.rows.length);
  const gpu = view.kind === "gpu";

  return (
    <AnCard
      title={t("an.wait.title")}
      hint={t("an.wait.hint", { n: meta.windowDays, m: meta.partitionUsers })}
      extra={t("an.wait.extra", { unit: unitWord(t, view), n: meta.windowDays, u: view.waits.users })}
      finding={f && (f.byP90
        ? rich(t, "an.wait.findingP90", { a: pctText(f.start1m), part: f.worst.name, p90: waitText(t, f.worst.p90) })
        : rich(t, "an.wait.finding", {
          a: pctText(f.start1m),
          part: f.worst.name,
          b: pctText(f.worst.buckets[4]),
          med: waitText(t, f.worst.p50),
        }))}
    >
      <Legend items={WAIT_KEYS.map((k, i) => ({ label: t(k), color: `var(--an-wait-${i})` }))} />
      <div className="subtle-scroll overflow-x-auto">
        <div className="min-w-[880px]">
          <div className="grid items-center gap-x-4 border-b border-border py-1.5 text-xs text-muted-foreground" style={{ gridTemplateColumns: COLS }}>
            <span>{t("an.wait.col.part")}</span>
            <span>{t("an.wait.col.limit")}</span>
            <span className="text-right">{t("an.wait.col.users")}</span>
            <span>{unitHours(t, view)}</span>
            <span>{t("an.wait.col.dist")}</span>
            <span className="text-right">{t("an.wait.col.p50")}</span>
            <span className="text-right">{t("an.wait.col.p90")}</span>
          </div>
          {groups.map(({ pool, index, rows }) => (
            <Fragment key={pool.id}>
              <div className="flex items-center gap-1.5 pb-1 pt-3 text-xs font-medium">
                <Dot color={poolColor(index)} />
                {poolLabel(t, pool.id)}
                <span className="font-normal text-muted-foreground">
                  {t(gpu ? "an.pool.gpuMeta" : "an.pool.cpuMeta", { n: nf(pool.units ?? 0), nodes: nf(pool.nodes ?? 0) })}
                  {pool.down > 0 && ` · ${t(gpu ? "an.pool.downGpu" : "an.pool.downNode", { n: pool.down })}`}
                </span>
              </div>
              {rows.map((p) => (
                <div key={p.name} className="grid items-center gap-x-4 border-b border-border/60 py-[7px] text-sm" style={{ gridTemplateColumns: COLS }}>
                  <span className="font-mono text-[0.8125rem] font-medium">{p.name}</span>
                  <span className="whitespace-nowrap text-[0.8125rem] text-muted-foreground">{specText(t, p)}</span>
                  <span className="tnum text-right text-[0.8125rem]">{p.users}</span>
                  <div className="flex items-center gap-2">
                    <div className="h-2 flex-1 rounded bg-[var(--an-track)]">
                      <div className="h-2 rounded bg-[var(--an-neutral)]" style={{ width: `${(p.unit_hours / maxHours) * 100}%` }} />
                    </div>
                    <span className="tnum w-[4.5rem] whitespace-nowrap text-right text-[0.8125rem]">
                      {p.unit_hours >= 100000 ? compactNumber(p.unit_hours, lang) : nf(p.unit_hours)}
                    </span>
                  </div>
                  <StackedBar
                    className="h-[22px]"
                    segments={p.buckets.map((v, i) => ({
                      value: v,
                      color: `var(--an-wait-${i})`,
                      ink: WAIT_INK[i],
                      label: i === 0 || i === 4 ? pctText(v) : undefined,
                      title: t("an.wait.seg", { part: p.name, bucket: t(WAIT_KEYS[i]), p: pctText(v) }),
                    }))}
                  />
                  <span className="tnum text-right text-[0.8125rem]">{waitText(t, p.p50)}</span>
                  <span className="tnum text-right text-[0.8125rem]">{waitText(t, p.p90)}</span>
                </div>
              ))}
            </Fragment>
          ))}
        </div>
      </div>
    </AnCard>
  );
}
