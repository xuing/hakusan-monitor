import { durText, poolLabel, useT, type TranslationKey } from "@/i18n";
import {
  limitStartFinding,
  mainPool,
  pctText,
  poolColor,
  shapeLabels,
  tUnit,
  unitHours,
  unitSteps,
  unitWord,
} from "@/lib/analytics-format";
import { nf } from "@/lib/format";
import type { AnalyticsMeta, AnalyticsView } from "@/types/analytics";
import { AnCard, Dot, Legend, StackedBar } from "./parts";
import { rich } from "./rich";

const RATIO_BINS = ["<5%", "5–10%", "10–25%", "25–50%", "50–75%", "≥75%"];
const LS_KEYS = ["an.ls.b0", "an.ls.b1", "an.ls.b2", "an.ls.b3", "an.ls.b4"] as TranslationKey[];
const END_KEYS = ["an.int.end0", "an.int.end1", "an.int.end2"] as TranslationKey[];
const END_COLORS = ["var(--an-warn)", "var(--an-ok)", "var(--an-cancel)"];
const END_INK = ["var(--an-warn-ink)", "var(--an-ok-ink)", "var(--an-cancel-ink)"];
const GRID = [100, 75, 50, 25, 0];

const memText = (gb: number | null | undefined) =>
  gb == null ? "—" : `${gb >= 10 ? Math.round(gb) : gb.toFixed(1)} GB`;

const poolIndex = (view: AnalyticsView, id: string) => view.pools.findIndex((p) => p.id === id);

/** How much of the requested --time batch jobs actually use. */
export function LimitAccuracy({ view }: { view: AnalyticsView }) {
  const t = useT();
  const lim = view.limits;
  const max = Math.max(0.01, ...lim.bins);
  const labels = [...RATIO_BINS, t("an.limit.hit")];
  return (
    <AnCard
      title={t("an.limit.title")}
      hint={t("an.limit.hint")}
      extra={t("an.limit.extra", { unit: unitWord(t, view), u: lim.users })}
      finding={lim.median != null && rich(t, "an.limit.finding", { m: pctText(lim.median), a: pctText(lim.at_max) })}
    >
      <div>
        <div className="flex h-[148px] items-end gap-2 border-b border-[var(--an-axis)]">
          {lim.bins.map((v, i) => (
            <div key={i} className="flex flex-1 flex-col items-center justify-end gap-1">
              <span className="tnum text-xs">{pctText(v)}</span>
              <div
                className="w-6 rounded-t-[4px]"
                title={t("an.limit.bar", { p: pctText(v), bin: labels[i] })}
                style={{
                  height: `${Math.max(1, (v / max) * 112)}px`,
                  background: i === labels.length - 1 ? "var(--an-warn)" : "var(--an-neutral)",
                }}
              />
            </div>
          ))}
        </div>
        <div className="mt-1.5 flex gap-2">
          {labels.map((l) => (
            <span key={l} className="flex-1 text-center text-xs text-muted-foreground">{l}</span>
          ))}
        </div>
        <div className="mt-0.5 text-center text-xs text-muted-foreground">{t("an.limit.axis")}</div>
      </div>
      {lim.top.length > 0 && (
        <div className="mt-auto flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-xs text-muted-foreground">{t("an.limit.top")}</span>
          {lim.top.map((x) => (
            <span key={x.minutes} className="inline-flex items-baseline gap-1.5 rounded-md border border-border bg-muted/50 px-2 py-0.5 text-[0.8125rem]">
              {durText(t, x.minutes * 60)}
              <span className="tnum text-xs text-muted-foreground">{pctText(x.share)}</span>
            </span>
          ))}
        </div>
      )}
    </AnCard>
  );
}

/** Share of batch jobs that started within an hour, by requested --time. */
export function LimitVsStart({ view, meta }: { view: AnalyticsView; meta: AnalyticsMeta }) {
  const t = useT();
  const pools = view.limit_start.pools;
  const f = limitStartFinding(view);
  const hint = [t("an.ls.hint", { m: meta.cellUsers }), meta.scheduler === "sched/backfill" ? t("an.ls.backfill") : ""]
    .filter(Boolean).join(" ");
  return (
    <AnCard
      title={t("an.ls.title")}
      hint={hint}
      extra={t("an.ls.extra", { n: meta.windowDays })}
      finding={f && rich(t, "an.ls.finding", {
        x: t(LS_KEYS[f.first]),
        y: t(LS_KEYS[f.last]),
        pool: poolLabel(t, f.pool.id),
        a: pctText(f.a),
        b: pctText(f.b),
      })}
    >
      <div className="flex min-h-[188px] flex-1 flex-col">
        <div className="mb-2 text-xs text-muted-foreground">{t("an.ls.y")}</div>
        <div className="relative ml-10 flex-1 border-b border-[var(--an-axis)]">
          {GRID.map((g) => (
            <div key={g}>
              <div className="absolute inset-x-0 border-t border-[var(--an-grid)]" style={{ top: `${100 - g}%` }} />
              <span className="tnum absolute -translate-y-1/2 text-xs text-muted-foreground" style={{ top: `${100 - g}%`, right: "calc(100% + 8px)" }}>
                {g}%
              </span>
            </div>
          ))}
          <div className="absolute inset-0 flex">
            {LS_KEYS.map((key, b) => (
              <div key={key} className="flex h-full min-w-0 flex-1 items-end justify-center gap-1 px-1">
                {pools.map((p) => {
                  const v = p.share[b];
                  const edge = b === 0 || b === LS_KEYS.length - 1;
                  return (
                    <div key={p.id} className="flex h-full min-w-0 max-w-[22px] flex-1 flex-col items-center justify-end">
                      <span className="tnum mb-0.5 hidden text-xs sm:inline">{v != null && edge ? pctText(v) : ""}</span>
                      <div
                        className="w-full rounded-t-[4px]"
                        title={v == null ? "" : t("an.ls.bar", { pool: poolLabel(t, p.id), x: t(key), p: pctText(v), u: p.users[b] })}
                        style={{ height: `${(v ?? 0) * 100}%`, background: poolColor(poolIndex(view, p.id)) }}
                      />
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
        <div className="ml-10 flex pt-1.5">
          {LS_KEYS.map((key) => (
            <span key={key} className="min-w-0 flex-1 text-center text-xs text-muted-foreground">{t(key)}</span>
          ))}
        </div>
        <div className="ml-10 mt-0.5 text-center text-xs text-muted-foreground">{t("an.ls.x")}</div>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {pools.map((p) => {
          const known = p.share.filter((v): v is number => v != null);
          return (
            <span key={p.id} className="tnum inline-flex items-center gap-1.5 text-[0.8125rem]">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ background: poolColor(poolIndex(view, p.id)) }} />
              {poolLabel(t, p.id)}
              {known.length > 1 && (
                <span className="text-muted-foreground">{pctText(known[0])} → {pctText(known[known.length - 1])}</span>
              )}
            </span>
          );
        })}
      </div>
    </AnCard>
  );
}

/** What a job asks for: GPUs per job and the cores / memory that go with them. */
export function JobShapes({ view, meta }: { view: AnalyticsView; meta: AnalyticsMeta }) {
  const t = useT();
  const gpu = view.kind === "gpu";
  const labels = shapeLabels(t, view.kind);
  const steps = unitSteps(labels.length);
  const shapes = view.shapes.pools;
  const main = mainPool(shapes, (p) => p.users);
  let finding = null;
  if (main && gpu) {
    finding = rich(t, "an.shape.finding.gpu", {
      a: pctText(main.buckets[0]),
      pool: poolLabel(t, main.id),
      c: nf(main.cpus_per_unit?.[0] ?? 0),
      m: memText(main.mem_gb_per_unit[0]),
    });
  } else if (main) {
    const k = main.buckets.indexOf(Math.max(...main.buckets));
    finding = rich(t, "an.shape.finding.cpu", {
      a: pctText(main.buckets[k]),
      pool: poolLabel(t, main.id),
      range: labels[k],
      m: memText(main.mem_gb_per_unit[0]),
    });
  }
  const cols = gpu ? "auto minmax(0, 1fr) auto auto" : "auto minmax(0, 1fr) auto";
  return (
    <AnCard
      title={t("an.shape.title")}
      hint={t(gpu ? "an.shape.hint.gpu" : "an.shape.hint.cpu")}
      extra={t("an.shape.extra", { n: meta.windowDays })}
      finding={finding}
    >
      <div className="grid items-center gap-x-3 gap-y-2.5" style={{ gridTemplateColumns: cols }}>
        <span className="text-xs text-muted-foreground">{t(gpu ? "an.col.pool.gpu" : "an.col.pool.cpu")}</span>
        <span className="text-xs text-muted-foreground">{t(gpu ? "an.shape.col.gpu" : "an.shape.col.cpu")}</span>
        {gpu && <span className="text-right text-xs text-muted-foreground">{t("an.shape.col.cpg")}</span>}
        <span className="text-right text-xs text-muted-foreground">{t(gpu ? "an.shape.col.mpg" : "an.shape.col.mpc")}</span>
        {shapes.map((p) => (
          <ShapeRow key={p.id} view={view} p={p} labels={labels} steps={steps} gpu={gpu} />
        ))}
      </div>
      <Legend className="mt-auto" items={labels.map((label, i) => ({ label, color: `var(--an-units-${steps[i]})` }))} />
    </AnCard>
  );
}

function ShapeRow({ view, p, labels, steps, gpu }: {
  view: AnalyticsView;
  p: AnalyticsView["shapes"]["pools"][number];
  labels: string[];
  steps: number[];
  gpu: boolean;
}) {
  const t = useT();
  const top = p.buckets.indexOf(Math.max(...p.buckets));
  return (
    <>
      <span className="inline-flex min-w-0 items-center gap-1.5 text-[0.8125rem] font-medium">
        <Dot color={poolColor(poolIndex(view, p.id))} />
        <span className="whitespace-nowrap">{poolLabel(t, p.id)}</span>
      </span>
      <StackedBar
        segments={p.buckets.map((v, i) => ({
          value: v,
          color: `var(--an-units-${steps[i]})`,
          ink: `var(--an-units-ink-${steps[i]})`,
          label: i === top ? pctText(v) : undefined,
          title: t("an.shape.seg", { pool: poolLabel(t, p.id), bucket: labels[i], p: pctText(v) }),
        }))}
      />
      {gpu && (
        <span className="tnum text-right text-[0.8125rem] leading-4">
          {nf(p.cpus_per_unit?.[0] ?? 0)}
          <br />
          <span className="whitespace-nowrap text-xs text-muted-foreground">{t("an.shape.p90", { v: nf(p.cpus_per_unit?.[1] ?? 0) })}</span>
        </span>
      )}
      <span className="tnum whitespace-nowrap text-right text-[0.8125rem] leading-4">
        {memText(p.mem_gb_per_unit[0])}
        <br />
        <span className="whitespace-nowrap text-xs text-muted-foreground">{t("an.shape.p90", { v: memText(p.mem_gb_per_unit[1]) })}</span>
      </span>
    </>
  );
}

/** salloc sessions: how they end, and their share of submissions and resource-hours. */
export function InteractiveSessions({ view, meta }: { view: AnalyticsView; meta: AnalyticsMeta }) {
  const t = useT();
  const pools = view.interactive.pools;
  const sessions = pools.reduce((a, p) => a + p.sessions, 0);
  const main = mainPool(pools, (p) => p.sessions);
  const caps = pools.map((p) => p.cap_min).filter((c): c is number => c != null);
  const cap = caps.length ? durText(t, caps[0] * 60) : "—";
  const uh = unitHours(t, view);
  return (
    <AnCard
      title={t("an.int.title")}
      hint={t("an.int.hint", { cap })}
      extra={t("an.int.extra", { n: meta.windowDays, s: nf(sessions) })}
      finding={main && rich(t, "an.int.finding", {
        a: pctText(main.end[0]),
        pool: poolLabel(t, main.id),
        cap: main.cap_min ? durText(t, main.cap_min * 60) : cap,
        b: pctText(main.end_hours[0]),
        unitH: uh,
      })}
    >
      <div className="grid items-center gap-x-3 gap-y-2.5" style={{ gridTemplateColumns: "auto minmax(4rem, 1fr) 3.75rem 3.75rem" }}>
        <span className="self-end text-xs text-muted-foreground">{t(view.kind === "gpu" ? "an.col.pool.gpu" : "an.col.pool.cpu")}</span>
        <span className="self-end text-xs text-muted-foreground">{t("an.int.col.end")}</span>
        <span className="self-end text-right text-xs leading-tight text-muted-foreground">{t("an.int.col.share")}</span>
        <span className="self-end text-right text-xs leading-tight text-muted-foreground">{tUnit(t, "an.int.col.hours", { unitH: uh })}</span>
        {pools.map((p) => (
          <InteractiveRow key={p.id} view={view} p={p} />
        ))}
      </div>
      <Legend className="mt-auto" items={END_KEYS.map((k, i) => ({ label: t(k), color: END_COLORS[i] }))} />
    </AnCard>
  );
}

function InteractiveRow({ view, p }: { view: AnalyticsView; p: AnalyticsView["interactive"]["pools"][number] }) {
  const t = useT();
  return (
    <>
      <span className="inline-flex min-w-0 items-center gap-1.5 text-[0.8125rem] font-medium">
        <Dot color={poolColor(poolIndex(view, p.id))} />
        <span className="whitespace-nowrap">{poolLabel(t, p.id)}</span>
      </span>
      <StackedBar
        segments={p.end.map((v, i) => ({
          value: v,
          color: END_COLORS[i],
          ink: END_INK[i],
          label: v >= 0.15 ? pctText(v) : undefined,
          title: t("an.int.seg", { pool: poolLabel(t, p.id), end: t(END_KEYS[i]), p: pctText(v), s: nf(p.sessions) }),
        }))}
      />
      <span className="tnum text-right text-[0.8125rem]">{pctText(p.share_submit)}</span>
      <span className="tnum text-right text-[0.8125rem]">{pctText(p.share_hours)}</span>
    </>
  );
}
