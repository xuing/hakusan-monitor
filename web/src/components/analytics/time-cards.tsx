import { useState } from "react";
import { poolLabel, useT, type TranslationKey } from "@/i18n";
import {
  WINDOW,
  dayLabel,
  freeFinding,
  heatColor,
  hourRange,
  joinList,
  mainPool,
  pctText,
  poolColor,
  submitFinding,
  unitWord,
} from "@/lib/analytics-format";
import type { AnalyticsMeta, AnalyticsView } from "@/types/analytics";
import { AnCard, Dot, HourAxis, RampLegend } from "./parts";
import { rich } from "./rich";

const SUBMIT_COLS = "3.5rem repeat(24, minmax(0, 1fr)) 3.5rem";
const FREE_COLS = "5.5rem repeat(24, minmax(0, 1fr)) 3.5rem";
const RAMP = [0, 0.25, 0.5, 0.75, 1];

const wdKey = (d: number) => `an.wd.${d}` as TranslationKey;

/** Weekday × hour grid of how many different people submit — people, not jobs. */
export function SubmitRhythm({ view, meta }: { view: AnalyticsView; meta: AnalyticsMeta }) {
  const t = useT();
  const [hover, setHover] = useState<{ d: number; h: number } | null>(null);
  const cells = view.submit.cells;
  const max = Math.max(0.1, ...cells.flat());
  const hourMax = Math.max(0.1, ...view.submit.by_hour);
  const f = submitFinding(view);

  let peak = { d: 0, h: 0 };
  cells.forEach((row, d) => row.forEach((v, h) => {
    if (v > cells[peak.d][peak.h]) peak = { d, h };
  }));
  const readout = hover
    ? t("an.submit.readout", { day: t(wdKey(hover.d)), hours: hourRange(t, hover.h), n: cells[hover.d][hover.h].toFixed(1) })
    : t("an.submit.peak", { day: t(wdKey(peak.d)), hours: hourRange(t, peak.h), n: cells[peak.d][peak.h].toFixed(1) });

  return (
    <AnCard
      title={t("an.submit.title")}
      hint={t("an.submit.hint", { w: view.submit.weeks })}
      extra={t("an.submit.extra", { unit: unitWord(t, view), n: meta.windowDays })}
      finding={f && rich(t, "an.submit.finding", {
        peak: hourRange(t, f.peak.from, WINDOW),
        a: f.peak.avg.toFixed(1),
        low: hourRange(t, f.low.from, WINDOW),
        b: f.low.avg.toFixed(1),
      })}
    >
      <div className="subtle-scroll overflow-x-auto">
        <div className="min-w-[480px]">
          <div className="grid h-11 items-end gap-x-[2px]" style={{ gridTemplateColumns: SUBMIT_COLS }}>
            <span className="self-start whitespace-nowrap text-xs text-muted-foreground">{t("an.submit.perHour")}</span>
            {view.submit.by_hour.map((v, h) => (
              <div key={h} className="flex h-full items-end" title={`${hourRange(t, h)} · ${v.toFixed(1)}`}>
                <div
                  className="w-full rounded-t-[3px]"
                  style={{
                    height: `${(v / hourMax) * 100}%`,
                    background: hover?.h === h ? "var(--an-blue-bar-on)" : "var(--an-blue-bar)",
                  }}
                />
              </div>
            ))}
            <span className="text-right text-xs text-muted-foreground">{t("an.submit.perDay")}</span>
          </div>
          <div
            className="mt-1 grid gap-[2px]"
            role="img"
            aria-label={`${t("an.submit.title")}: ${readout}`}
            onMouseLeave={() => setHover(null)}
          >
            {cells.map((row, d) => (
              <div key={d} className="grid items-center gap-x-[2px]" style={{ gridTemplateColumns: SUBMIT_COLS }}>
                <span className="text-xs text-muted-foreground">{t(wdKey(d))}</span>
                {row.map((v, h) => (
                  <div
                    key={h}
                    className="an-cell h-[17px] rounded-[3px]"
                    data-on={hover?.d === d && hover?.h === h}
                    title={t("an.submit.readout", { day: t(wdKey(d)), hours: hourRange(t, h), n: v.toFixed(1) })}
                    onMouseEnter={() => setHover({ d, h })}
                    style={{ background: heatColor("blue", v / max) }}
                  />
                ))}
                <span className="tnum text-right text-xs">{view.submit.by_weekday[d].toFixed(1)}</span>
              </div>
            ))}
          </div>
          <HourAxis columns={SUBMIT_COLS} />
        </div>
      </div>
      <div className="mt-auto flex flex-wrap items-center justify-between gap-2">
        <RampLegend
          colors={RAMP.map((x) => heatColor("blue", x))}
          from="0"
          to={t("an.submit.legend", { n: max.toFixed(1) })}
        />
        <span className="tnum text-xs text-foreground">{readout}</span>
      </div>
    </AnCard>
  );
}

/** Share of time each pool had something free: GPU pools a free GPU, CPU pools
 *  a whole idle node — split weekday / weekend by hour. */
export function FreeHours({ view }: { view: AnalyticsView }) {
  const t = useT();
  const [hover, setHover] = useState<{ p: number; we: boolean; h: number } | null>(null);
  const metric = view.free.metric;
  const pools = view.free.pools;
  const known = pools.filter((p) => p.mean != null);
  const main = mainPool(known, (p) => view.pools.find((x) => x.id === p.id)?.units ?? 0);
  const f = main && freeFinding(main);
  const thing = t(metric === "gpu" ? "an.free.thing.gpu" : "an.free.thing.node");

  let readout = "";
  const hovered = hover ? pools[hover.p] : undefined;
  if (hover && hovered) {
    const pool = hovered;
    const v = (hover.we ? pool.weekend : pool.weekday)[hover.h];
    readout = t("an.free.readout", {
      pool: poolLabel(t, pool.id),
      part: t(hover.we ? "an.weekend" : "an.weekday"),
      hours: hourRange(t, hover.h),
      p: pctText(v),
    });
  } else if (main && f) {
    const worstHour = main.weekday.reduce<number>(
      (best, v, h) => (v != null && (main.weekday[best] == null || v < (main.weekday[best] as number)) ? h : best), 0);
    readout = t("an.free.lowest", {
      pool: poolLabel(t, main.id),
      hours: hourRange(t, worstHour),
      p: pctText(main.weekday[worstHour]),
    });
  }

  return (
    <AnCard
      title={t(metric === "gpu" ? "an.free.title.gpu" : "an.free.title.node")}
      hint={metric === "gpu"
        ? t("an.free.hint.gpu")
        : [t("an.free.hint.node"), view.whole_node_partitions.length
          ? t("an.free.hint.nodeParts", { parts: joinList(t, view.whole_node_partitions) }) : ""]
          .filter(Boolean).join(" ")}
      extra={view.free.since ? t("an.free.extra", { since: dayLabel(view.free.since, true) }) : undefined}
      finding={main && f && rich(t, "an.free.finding", {
        pool: poolLabel(t, main.id),
        thing,
        best: hourRange(t, f.best.from, WINDOW),
        a: pctText(f.best.avg),
        worst: hourRange(t, f.worst.from, WINDOW),
        b: pctText(f.worst.avg),
        c: pctText(f.weekend),
      })}
    >
      {!known.length ? (
        <p className="py-6 text-center text-sm text-muted-foreground">{t("an.free.none")}</p>
      ) : (
        <div className="subtle-scroll overflow-x-auto">
          <div
            className="grid min-w-[480px] gap-[2px]"
            role="img"
            aria-label={`${t(metric === "gpu" ? "an.free.title.gpu" : "an.free.title.node")}: ${readout}`}
            onMouseLeave={() => setHover(null)}
          >
            {pools.map((pool, p) => {
              const meta = view.pools.find((x) => x.id === pool.id);
              const idx = view.pools.findIndex((x) => x.id === pool.id);
              return (
                <div key={pool.id} className={p ? "mt-2 grid gap-[2px]" : "grid gap-[2px]"}>
                  <div className="grid h-5 items-center gap-x-[2px]" style={{ gridTemplateColumns: FREE_COLS }}>
                    <span className="flex items-center gap-1.5 text-xs font-medium" style={{ gridColumn: "1 / span 25" }}>
                      <Dot color={poolColor(idx)} />
                      {poolLabel(t, pool.id)}
                      {meta && meta.down > 0 && (
                        <span className="font-normal text-muted-foreground">
                          · {t(metric === "gpu" ? "an.pool.downGpu" : "an.pool.downNode", { n: meta.down })}
                        </span>
                      )}
                    </span>
                    <span className="text-right text-xs text-muted-foreground">{t("an.free.allDay")}</span>
                  </div>
                  {([false, true] as const).map((we) => {
                    const series = we ? pool.weekend : pool.weekday;
                    const vals = series.filter((v): v is number => v != null);
                    const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
                    return (
                      <div key={String(we)} className="grid items-center gap-x-[2px]" style={{ gridTemplateColumns: FREE_COLS }}>
                        <span className="whitespace-nowrap pl-3.5 text-xs text-muted-foreground">{t(we ? "an.weekend" : "an.weekday")}</span>
                        {series.map((v, h) => (
                          <div
                            key={h}
                            className="an-cell h-[17px] rounded-[3px]"
                            data-on={hover?.p === p && hover.we === we && hover.h === h}
                            title={t("an.free.readout", {
                              pool: poolLabel(t, pool.id),
                              part: t(we ? "an.weekend" : "an.weekday"),
                              hours: hourRange(t, h),
                              p: pctText(v),
                            })}
                            onMouseEnter={() => setHover({ p, we, h })}
                            style={{ background: heatColor("green", v) }}
                          />
                        ))}
                        <span className="tnum text-right text-xs">{pctText(avg)}</span>
                      </div>
                    );
                  })}
                </div>
              );
            })}
            <HourAxis columns={FREE_COLS} />
          </div>
        </div>
      )}
      <div className="mt-auto flex flex-wrap items-center justify-between gap-2">
        <RampLegend
          colors={RAMP.map((x) => heatColor("green", x))}
          from="0%"
          to={`100% ${t(metric === "gpu" ? "an.free.legend.gpu" : "an.free.legend.node")}`}
        />
        {readout && <span className="tnum text-xs text-foreground">{readout}</span>}
      </div>
    </AnCard>
  );
}
