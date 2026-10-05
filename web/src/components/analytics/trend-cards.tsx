import { poolLabel, useI18n, useT, type TranslationKey } from "@/i18n";
import {
  compactNumber,
  concentrationFinding,
  dayLabel,
  dayRun,
  joinList,
  mainPool,
  monthLabel,
  pctText,
  poolColor,
  tUnit,
  unitHours,
  unitNoun,
  unitWord,
  usersFinding,
} from "@/lib/analytics-format";
import { nf } from "@/lib/format";
import type { AnalyticsMeta, AnalyticsView } from "@/types/analytics";
import { AnCard, Dot, Legend, StackedBar } from "./parts";
import { rich } from "./rich";

const RT_KEYS = ["an.rt.b0", "an.rt.b1", "an.rt.b2", "an.rt.b3", "an.rt.b4", "an.rt.b5", "an.rt.b6"] as TranslationKey[];
const OUT_KEYS = ["an.out.s0", "an.out.s1", "an.out.s2", "an.out.s3", "an.out.s4"] as TranslationKey[];
const OUT_COLORS = ["var(--an-ok)", "var(--an-bad)", "var(--an-warn)", "var(--an-serious)", "var(--an-cancel)"];
const OUT_INK = ["var(--an-ok-ink)", "var(--an-bad-ink)", "var(--an-warn-ink)", "var(--an-serious-ink)", "var(--an-cancel-ink)"];
const GRID = [100, 75, 50, 25, 0];

const poolIndex = (view: AnalyticsView, id: string) => view.pools.findIndex((p) => p.id === id);

/** Share of jobs vs. share of resource-hours per run-time band (butterfly). */
export function RuntimeSplit({ view, meta }: { view: AnalyticsView; meta: AnalyticsMeta }) {
  const t = useT();
  const rt = view.runtime;
  const scale = Math.max(0.01, ...rt.jobs, ...rt.hours);
  const uh = unitHours(t, view);
  const last = rt.jobs.length - 1;
  return (
    <AnCard
      title={t("an.rt.title")}
      hint={tUnit(t, "an.rt.hint", { unitH: uh })}
      extra={t("an.rt.extra", { unit: unitWord(t, view), n: meta.windowDays })}
      finding={rich(t, "an.rt.finding", {
        a: pctText(rt.jobs[0] + rt.jobs[1]),
        b: pctText(rt.jobs[last]),
        c: pctText(rt.hours[last]),
        unitH: uh,
      })}
    >
      <div className="grid items-center gap-x-2 gap-y-[5px]" style={{ gridTemplateColumns: "minmax(0, 1fr) 6.25rem minmax(0, 1fr)" }}>
        <span className="flex items-center justify-end gap-1.5 text-xs text-muted-foreground">
          {t("an.rt.jobs")}
          <span className="h-2.5 w-2.5 rounded-sm bg-[var(--an-neutral-soft)]" />
        </span>
        <span />
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="h-2.5 w-2.5 rounded-sm bg-[var(--an-violet)]" />
          {uh}
        </span>
        {RT_KEYS.map((key, i) => (
          <RuntimeRow key={key} label={t(key)} jobs={rt.jobs[i]} hours={rt.hours[i]} scale={scale} />
        ))}
      </div>
    </AnCard>
  );
}

function RuntimeRow({ label, jobs, hours, scale }: { label: string; jobs: number; hours: number; scale: number }) {
  const t = useT();
  return (
    <>
      <div className="flex h-[18px] items-center justify-end gap-1.5">
        <span className="tnum text-xs">{pctText(jobs)}</span>
        <div
          className="h-3.5 rounded-l-[4px] bg-[var(--an-neutral-soft)]"
          title={t("an.rt.bar", { bucket: label, p: pctText(jobs) })}
          style={{ width: `${(jobs / scale) * 100}%` }}
        />
      </div>
      <span className="whitespace-nowrap text-center text-xs text-muted-foreground">{label}</span>
      <div className="flex h-[18px] items-center gap-1.5">
        <div
          className="h-3.5 rounded-r-[4px] bg-[var(--an-violet)]"
          title={t("an.rt.bar", { bucket: label, p: pctText(hours) })}
          style={{ width: `${(hours / scale) * 100}%` }}
        />
        <span className="tnum text-xs">{pctText(hours)}</span>
      </div>
    </>
  );
}

/** Weekly allocation per pool since the cluster opened. */
export function WeeklyAllocation({ view, meta, className }: { view: AnalyticsView; meta: AnalyticsMeta; className?: string }) {
  const { t, lang } = useI18n();
  const w = view.weekly;
  const n = w.starts.length;
  const x = (i: number) => (n > 1 ? (i / (n - 1)) * 100 : 50);
  const series = view.pools.map((p, idx) => ({ id: p.id, color: poolColor(idx), values: w.util[p.id] ?? [] }));
  const gpu = view.kind === "gpu";

  // end labels: last value per series, nudged apart when they would overlap
  const ends = series
    .map((s) => {
      let i = s.values.length - 1;
      while (i >= 0 && s.values[i] == null) i--;
      return i < 0 ? null : { id: s.id, color: s.color, i, v: s.values[i] as number };
    })
    .filter((e): e is NonNullable<typeof e> => e != null)
    .sort((a, b) => b.v - a.v);
  const labelTop: Record<string, number> = {};
  const tops = ends.map((e) => (1 - e.v) * 100);
  for (let i = 1; i < tops.length; i++) tops[i] = Math.max(tops[i], tops[i - 1] + 11);
  for (let i = tops.length - 1; i >= 0; i--) {
    tops[i] = Math.min(tops[i], (i === tops.length - 1 ? 100 : tops[i + 1] - 11));
  }
  ends.forEach((e, i) => { labelTop[e.id] = tops[i]; });

  const ticks: { i: number; label: string }[] = [];
  let lastMonth = "";
  w.starts.forEach((ts, i) => {
    const month = dayLabel(ts + 3 * 86400, true).slice(0, 7);
    if (month !== lastMonth) {
      ticks.push({ i, label: monthLabel(month, lang) });
      lastMonth = month;
    }
  });

  // the week an outage falls in: the last week starting on or before its first day
  const weekDays = w.starts.map((ts) => dayLabel(ts, true));
  const notes = meta.outages
    .map((run) => {
      let idx = -1;
      weekDays.forEach((d, i) => { if (d <= run[0]) idx = i; });
      return idx >= 0 ? { idx, label: t("an.wk.note", { days: dayRun(run) }) } : null;
    })
    .filter((v): v is NonNullable<typeof v> => v != null);
  const latest = meta.outages.length ? meta.outages[meta.outages.length - 1] : null;
  const list = joinList(t, view.pools
    .filter((p) => w.util13.pools[p.id] != null)
    .map((p) => `${poolLabel(t, p.id)} ${pctText(w.util13.pools[p.id])}`));

  return (
    <AnCard
      className={className}
      title={t("an.wk.title", { unit: unitWord(t, view) })}
      hint={tUnit(t, "an.wk.hint", { unitH: unitHours(t, view), unitN: unitNoun(t, view) })}
      extra={meta.historySince ? t("an.wk.extra", { since: dayLabel(meta.historySince, true) }) : undefined}
      finding={latest && notes.length
        ? rich(t, "an.wk.findingOutage", { n: w.util13.weeks, list, days: dayRun(latest) })
        : rich(t, "an.wk.finding", { n: w.util13.weeks, list })}
    >
      <div className="relative min-h-[200px] flex-1">
        <div className="absolute bottom-[26px] left-10 right-12 top-6">
          {GRID.map((g) => (
            <div key={g}>
              <div
                className="absolute inset-x-0 border-t"
                style={{ top: `${100 - g}%`, borderColor: g === 0 ? "var(--an-axis)" : "var(--an-grid)" }}
              />
              <span className="tnum absolute -translate-y-1/2 text-xs text-muted-foreground" style={{ top: `${100 - g}%`, right: "calc(100% + 8px)" }}>
                {g}%
              </span>
            </div>
          ))}
          {notes.map((note) => (
            <div key={note.label}>
              <div className="absolute bottom-0 border-l border-[var(--an-axis)]" style={{ left: `${x(note.idx)}%`, top: -18 }} />
              <span className="absolute whitespace-nowrap pl-1.5 text-xs text-muted-foreground" style={{ left: `${x(note.idx)}%`, top: -22 }}>
                {note.label}
              </span>
            </div>
          ))}
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 h-full w-full overflow-visible" aria-hidden>
            {series.map((s) => segments(s.values).map((seg, k) => (
              <polyline
                key={`${s.id}-${k}`}
                points={seg.map((i) => `${x(i)},${100 - (s.values[i] as number) * 100}`).join(" ")}
                fill="none"
                stroke={s.color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            )))}
          </svg>
          {ends.map((e) => (
            <div key={e.id}>
              <div
                className="absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-card"
                style={{ left: `${x(e.i)}%`, top: `${(1 - e.v) * 100}%`, background: e.color }}
              />
              <span
                className="tnum absolute -translate-y-1/2 whitespace-nowrap text-xs"
                style={{ left: "calc(100% + 10px)", top: `${labelTop[e.id]}%` }}
                title={poolLabel(t, e.id)}
              >
                {pctText(e.v)}
              </span>
            </div>
          ))}
          {w.starts.map((ts, i) => (
            <div
              key={ts}
              className="absolute inset-y-0 hover:bg-muted/40"
              style={{ left: `${Math.max(0, x(i) - 50 / Math.max(1, n - 1))}%`, width: `${100 / Math.max(1, n - 1)}%` }}
              title={[
                i === n - 1 && w.partial ? t("an.wk.partial") : t("an.wk.week", { date: dayLabel(ts) }),
                ...series.map((s) => `${poolLabel(t, s.id)} ${pctText(s.values[i])}`),
              ].join(" · ")}
            />
          ))}
          {ticks.map((tick) => (
            <span key={tick.i} className="absolute -translate-x-1/2 whitespace-nowrap text-xs text-muted-foreground" style={{ left: `${x(tick.i)}%`, top: "calc(100% + 8px)" }}>
              {tick.label}
            </span>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {view.pools.map((p, idx) => (
          <span key={p.id} className="inline-flex items-center gap-1.5 text-[0.8125rem]">
            <span className="h-0.5 w-3.5 rounded" style={{ background: poolColor(idx) }} />
            {poolLabel(t, p.id)}
            <span className="text-xs text-muted-foreground">
              {t(gpu ? "an.pool.gpuMeta" : "an.pool.cpuMeta", { n: nf(p.units ?? 0), nodes: nf(p.nodes ?? 0) })}
            </span>
          </span>
        ))}
      </div>
    </AnCard>
  );
}

/** Index runs without gaps, so a missing week breaks the line instead of bridging it. */
function segments(values: (number | null)[]): number[][] {
  const out: number[][] = [];
  let run: number[] = [];
  values.forEach((v, i) => {
    if (v == null) {
      if (run.length) out.push(run);
      run = [];
    } else run.push(i);
  });
  if (run.length) out.push(run);
  return out;
}

/** How concentrated resource-hours are: users ranked and grouped, ribbons
 *  joining each group's share of people to its share of hours. */
export function UsageConcentration({ view, meta, className }: { view: AnalyticsView; meta: AnalyticsMeta; className?: string }) {
  const { t, lang } = useI18n();
  const c = view.concentration;
  const f = concentrationFinding(view);
  const uh = unitHours(t, view);
  const gap = 0.6;
  const groups: (typeof c.groups[number] & { t0: number; t1: number; b0: number; b1: number; label: string; color: string })[] = [];
  let tAcc = 0;
  let bAcc = 0;
  for (const [i, g] of c.groups.entries()) {
    const people = ((g.to - g.from + 1) / Math.max(1, c.users)) * 100;
    const isLast = i === c.groups.length - 1;
    const t0 = tAcc;
    const b0 = bAcc;
    tAcc += people;
    bAcc += g.share * 100;
    const label = g.from === 1 && g.to === 1
      ? t("an.conc.g1")
      : g.rest
        ? t("an.conc.rest", { n: g.to - g.from + 1 })
        : t("an.conc.gRange", { a: g.from, b: g.to });
    groups.push({
      ...g,
      t0,
      t1: Math.max(t0 + 0.4, tAcc - (isLast ? 0 : gap)),
      b0,
      b1: Math.max(b0 + 0.4, bAcc - (isLast ? 0 : gap)),
      label,
      color: `var(--an-conc-${Math.min(i, 4)})`,
    });
  }
  return (
    <AnCard
      className={className}
      title={t("an.conc.title")}
      hint={tUnit(t, "an.conc.hint", { n: meta.windowDays, u: c.users, unitN: unitNoun(t, view), unitH: uh })}
      extra={tUnit(t, "an.conc.extra", { n: meta.windowDays, h: compactNumber(c.unit_hours, lang), unitH: uh })}
      finding={f && rich(t, "an.conc.finding", {
        n: f.n, p: pctText(f.people), s: pctText(f.share), h: f.half, unitH: uh,
      })}
    >
      <div>
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>{t("an.conc.users", { n: c.users })}</span>
          <span>{t("an.conc.order")}</span>
        </div>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="mt-1 block h-[132px] w-full" role="img" aria-label={t("an.conc.title")}>
          {groups.map((g) => (
            <g key={g.from}>
              <rect x={g.t0} y={0} width={g.t1 - g.t0} height={12} fill={g.color} />
              <polygon points={`${g.t0},12 ${g.t1},12 ${g.b1},84 ${g.b0},84`} fill={g.color} opacity={0.22} />
              <rect x={g.b0} y={84} width={g.b1 - g.b0} height={16} fill={g.color} />
            </g>
          ))}
        </svg>
        <div className="mt-1 text-xs text-muted-foreground">{tUnit(t, "an.conc.total", { unitH: uh, h: compactNumber(c.unit_hours, lang) })}</div>
      </div>
      <div className="flex flex-wrap gap-x-3.5 gap-y-1">
        {groups.map((g) => (
          <span key={g.from} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: g.color }} />
            {g.label}
            <span className="tnum font-semibold text-foreground">{pctText(g.share)}</span>
          </span>
        ))}
      </div>
      {meta.fairShare > 0 && (
        <p className="mt-auto text-xs leading-relaxed text-muted-foreground">
          {t("an.conc.fairshare", { w: nf(meta.fairShare) })}
        </p>
      )}
    </AnCard>
  );
}

/** People submitting per week since the cluster opened, and new users per month. */
export function ActiveUsers({ view, meta, className }: { view: AnalyticsView; meta: AnalyticsMeta; className?: string }) {
  const { t, lang } = useI18n();
  const w = view.weekly;
  const users = w.users;
  const max = Math.max(1, ...users);
  const peak = users.indexOf(Math.max(...users));
  const f = usersFinding(view);
  const total = w.new_users.reduce((a, m) => a + m.users, 0);
  const newMax = Math.max(1, ...w.new_users.map((m) => m.users));
  const unit = unitWord(t, view);
  const ticks: { i: number; label: string }[] = [];
  let lastMonth = "";
  w.starts.forEach((ts, i) => {
    const month = dayLabel(ts + 3 * 86400, true).slice(0, 7);
    if (month !== lastMonth) {
      ticks.push({ i, label: monthLabel(month, lang) });
      lastMonth = month;
    }
  });
  return (
    <AnCard
      className={className}
      title={t("an.users.title")}
      hint={t("an.users.hint", { unit })}
      extra={meta.historySince ? t("an.users.extra", { since: dayLabel(meta.historySince, true), n: total, unit }) : undefined}
      finding={f && rich(t, "an.users.finding", {
        w: f.weeks, a: f.min, b: f.max, unit, month: monthLabel(f.top.month, lang), n: f.top.users,
      })}
    >
      <div className="flex flex-wrap items-end gap-6">
        <div className="min-w-0 flex-[3_1_22rem]">
          <div className="mb-1.5 text-xs text-muted-foreground">{t("an.users.weekly", { unit })}</div>
          <div className="flex h-[120px] items-end gap-[3px] border-b border-[var(--an-axis)]">
            {users.map((v, i) => (
              <div key={i} className="flex h-full flex-1 flex-col items-center justify-end gap-0.5">
                <span className="tnum text-xs leading-[14px] text-muted-foreground">
                  {i === peak || i === users.length - 1 ? v : ""}
                </span>
                <div
                  className="w-full max-w-[14px] rounded-t-[3px] bg-[var(--an-neutral)]"
                  title={i === users.length - 1 && w.partial
                    ? `${t("an.wk.partial")} · ${v}`
                    : t("an.users.bar", { date: dayLabel(w.starts[i]), n: v })}
                  style={{ height: `${(v / max) * 100}%`, opacity: i === users.length - 1 && w.partial ? 0.5 : 1 }}
                />
              </div>
            ))}
          </div>
          <div className="relative h-[18px]">
            {ticks.map((tick) => (
              <span key={tick.i} className="absolute top-1 whitespace-nowrap text-xs text-muted-foreground" style={{ left: `${(tick.i / Math.max(1, users.length)) * 100}%` }}>
                {tick.label}
              </span>
            ))}
          </div>
        </div>
        <div className="min-w-0 flex-[1_1_12rem]">
          <div className="mb-1.5 text-xs text-muted-foreground">{t("an.users.new")}</div>
          <div className="flex h-[120px] items-end gap-1.5 border-b border-[var(--an-axis)]">
            {w.new_users.map((m) => (
              <div key={m.month} className="flex h-full flex-1 flex-col items-center justify-end gap-0.5">
                <span className="tnum text-xs leading-[14px]">{m.users}</span>
                <div className="w-full max-w-5 rounded-t-[3px] bg-[var(--an-neutral)]" style={{ height: `${(m.users / newMax) * 100}%` }} />
              </div>
            ))}
          </div>
          <div className="flex h-[18px] gap-1.5">
            {w.new_users.map((m) => (
              <span key={m.month} className="flex-1 whitespace-nowrap pt-1 text-center text-xs text-muted-foreground">{monthLabel(m.month, lang)}</span>
            ))}
          </div>
        </div>
      </div>
    </AnCard>
  );
}

/** Final state of finished batch jobs per pool. */
export function BatchOutcomes({ view, meta, className }: { view: AnalyticsView; meta: AnalyticsMeta; className?: string }) {
  const t = useT();
  const pools = view.outcomes.pools;
  const main = mainPool(pools, (p) => p.users);
  return (
    <AnCard
      className={className}
      title={t("an.out.title")}
      hint={t("an.out.hint")}
      extra={t("an.out.extra", { n: meta.windowDays })}
      finding={main && rich(t, "an.out.finding", {
        pool: poolLabel(t, main.id), a: pctText(main.states[0]), b: pctText(main.fail_fast),
      })}
    >
      <div className="grid items-center gap-x-3 gap-y-2.5" style={{ gridTemplateColumns: "auto minmax(0, 1fr) auto" }}>
        <span className="text-xs text-muted-foreground">{t(view.kind === "gpu" ? "an.col.pool.gpu" : "an.col.pool.cpu")}</span>
        <span className="text-xs text-muted-foreground">{t("an.out.col.state")}</span>
        <span className="whitespace-nowrap text-right text-xs text-muted-foreground">{t("an.out.fast")}</span>
        {pools.map((p) => (
          <OutcomeRow key={p.id} view={view} p={p} />
        ))}
      </div>
      <Legend className="mt-auto" items={OUT_KEYS.map((k, i) => ({ label: t(k), color: OUT_COLORS[i] }))} />
    </AnCard>
  );
}

function OutcomeRow({ view, p }: { view: AnalyticsView; p: AnalyticsView["outcomes"]["pools"][number] }) {
  const t = useT();
  return (
    <>
      <span className="inline-flex min-w-0 items-center gap-1.5 text-[0.8125rem] font-medium">
        <Dot color={poolColor(poolIndex(view, p.id))} />
        <span className="whitespace-nowrap">{poolLabel(t, p.id)}</span>
      </span>
      <StackedBar
        segments={p.states.map((v, i) => ({
          value: v,
          color: OUT_COLORS[i],
          ink: OUT_INK[i],
          label: v >= 0.15 ? pctText(v) : undefined,
          title: `${poolLabel(t, p.id)} · ${t(OUT_KEYS[i])} · ${pctText(v)}`,
        }))}
      />
      <span className="tnum text-right text-[0.8125rem]">{pctText(p.fail_fast)}</span>
    </>
  );
}
