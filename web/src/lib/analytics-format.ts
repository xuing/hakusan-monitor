// Formatting and "finding" extraction for the analytics page. Every card leads
// with one sentence computed here from the payload, so the copy always states
// what the current data says (no hand-written numbers).
import type { Lang, TFn, TranslationKey } from "@/i18n";
import { clusterTimeZone } from "@/lib/cluster-time";
import type { AnalyticsView } from "@/types/analytics";

export const WINDOW = 4; // hours in a "busiest / quietest" window

/** 0–1 share -> "51%"; tiny non-zero shares read "<1%". */
export function pctText(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  if (v > 0 && v < 0.005) return "<1%";
  return `${Math.round(v * 100)}%`;
}

/** Seconds -> one-unit duration: "30 秒", "12 分钟", "5.6 小时", "1.2 天". */
export function waitText(t: TFn, sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return "—";
  const fix = (x: number) => (x < 10 ? x.toFixed(1) : String(Math.round(x)));
  if (sec < 60) return t("an.sec", { n: Math.round(sec) });
  if (sec < 3600) return t("an.min", { n: Math.round(sec / 60) });
  if (sec < 86400) return t("an.hour", { n: fix(sec / 3600) });
  return t("an.day", { n: fix(sec / 86400) });
}

/** Hours [from, from+len) as "13–17 时" / "13:00–17:00"; wraps past midnight. */
export function hourRange(t: TFn, from: number, len = 1): string {
  const end = from + len;
  const to = end > 24 ? end - 24 : end;
  const pad = (h: number) => String(h).padStart(2, "0");
  return t("an.hours", { from: pad(from), to: pad(to) });
}

const LOCALE: Record<Lang, string> = { en: "en", ja: "ja-JP", zh: "zh-CN" };

/** 119098 -> "11.9万" / "119K"; 15099110 -> "1510万" / "15.1M". */
export function compactNumber(n: number, lang: Lang): string {
  return new Intl.NumberFormat(LOCALE[lang], { notation: "compact", maximumSignificantDigits: 3 }).format(n);
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const UNIT_VARS = ["unitH", "unitN"];

/** Templates put spaces around {unitH}/{unitN} ("用掉了 {s} 的 {unitH}"), right for
 *  "GPU·时"; a CJK unit ("核·时") sits flush against CJK neighbours instead. */
export function tidyUnits(template: string, vars: Record<string, string | number>): string {
  let out = template;
  for (const name of UNIT_VARS) {
    const value = String(vars[name] ?? "");
    if (!value) continue;
    if (CJK.test(value[0])) out = out.replace(new RegExp(`(\\p{Script=Han}|\\p{Script=Hiragana}|\\p{Script=Katakana}) \\{${name}\\}`, "gu"), `$1{${name}}`);
    if (CJK.test(value[value.length - 1])) out = out.replace(new RegExp(`\\{${name}\\} (\\p{Script=Han}|\\p{Script=Hiragana}|\\p{Script=Katakana})`, "gu"), `{${name}}$1`);
  }
  return out;
}

/** t() for templates that hold a unit placeholder. */
export function tUnit(t: TFn, key: TranslationKey, vars: Record<string, string | number>): string {
  let s = tidyUnits(t(key), vars);
  for (const name in vars) s = s.replaceAll(`{${name}}`, String(vars[name]));
  return s;
}

/** "2026-04" -> "4月" / "Apr". */
export function monthLabel(month: string, lang: Lang): string {
  const [y, m] = month.split("-").map(Number);
  return new Intl.DateTimeFormat(LOCALE[lang], { month: "short", timeZone: "UTC" })
    .format(new Date(Date.UTC(y, m - 1, 15)));
}

/** Epoch -> cluster-local "MM-DD" / "YYYY-MM-DD". */
export function dayLabel(ts: number, withYear = false): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: clusterTimeZone(), year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(ts * 1000));
  return withYear ? parts : parts.slice(5);
}

/** "2026-05-16" -> "05-16"; a run of days -> "05-16–05-17". */
export function dayRun(run: [string, string]): string {
  const [a, b] = run.map((d) => d.slice(5));
  return a === b ? a : `${a}–${b}`;
}

/** Joins with the language's list separator (、 / , ). */
export function joinList(t: TFn, items: string[]): string {
  return items.join(t("an.list"));
}

export const unitWord = (t: TFn, view: Pick<AnalyticsView, "kind">) =>
  t(view.kind === "gpu" ? "an.unit.gpu" : "an.unit.cpu");
export const unitHours = (t: TFn, view: Pick<AnalyticsView, "kind">) =>
  t(view.kind === "gpu" ? "an.unitH.gpu" : "an.unitH.cpu");
export const unitNoun = (t: TFn, view: Pick<AnalyticsView, "kind">) =>
  t(view.kind === "gpu" ? "an.unitN.gpu" : "an.unitN.cpu");

/** CSS colour of a pool's identity slot (fixed order within the view). */
export const poolColor = (index: number) => `var(--an-pool-${Math.min(index, 3) + 1})`;

/** One-hue sequential ramp through three stops, mixed in OKLab. */
export function heatColor(ramp: "blue" | "green", v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "hsl(var(--muted))";
  const x = Math.max(0, Math.min(1, v));
  const [lo, mid, hi] = [`var(--an-${ramp}-lo)`, `var(--an-${ramp}-mid)`, `var(--an-${ramp}-hi)`];
  return x <= 0.5
    ? `color-mix(in oklab, ${mid} ${Math.round(x * 200)}%, ${lo})`
    : `color-mix(in oklab, ${hi} ${Math.round((x - 0.5) * 200)}%, ${mid})`;
}

/** Best (or worst) run of `len` consecutive hours, wrapping past midnight.
 *  Windows touching a missing hour are skipped. */
export function bestWindow(series: (number | null)[], len: number, mode: "max" | "min") {
  let best: { from: number; avg: number } | null = null;
  for (let from = 0; from < series.length; from++) {
    let sum = 0;
    let ok = true;
    for (let i = 0; i < len; i++) {
      const v = series[(from + i) % series.length];
      if (v == null) { ok = false; break; }
      sum += v;
    }
    if (!ok) continue;
    const avg = sum / len;
    if (!best || (mode === "max" ? avg > best.avg + 1e-9 : avg < best.avg - 1e-9)) best = { from, avg };
  }
  return best;
}

const mean = (xs: (number | null)[]) => {
  const v = xs.filter((x): x is number => x != null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};

/** Weekday (Mon–Fri) average per hour of the submit grid. */
function weekdayHours(view: AnalyticsView): number[] {
  return Array.from({ length: 24 }, (_, h) => mean(view.submit.cells.slice(0, 5).map((r) => r[h])) ?? 0);
}

export function submitFinding(view: AnalyticsView) {
  const hours = weekdayHours(view);
  const peak = bestWindow(hours, WINDOW, "max");
  const low = bestWindow(hours, WINDOW, "min");
  return peak && low && peak.avg > 0 ? { peak, low } : null;
}

export function freeFinding(pool: AnalyticsView["free"]["pools"][number]) {
  const best = bestWindow(pool.weekday, WINDOW, "max");
  const worst = bestWindow(pool.weekday, WINDOW, "min");
  const weekend = mean(pool.weekend);
  return best && worst && weekend != null ? { best, worst, weekend } : null;
}

/** The pool a sentence talks about: the one with the most users in that card. */
export function mainPool<T extends { id: string }>(items: T[], weight: (x: T) => number): T | null {
  return items.reduce<T | null>((best, x) => (!best || weight(x) > weight(best) ? x : best), null);
}

/** The partition that waits longest: most jobs waiting over a day, or — when
 *  none waited that long — the longest 90th-percentile wait. */
export function waitFinding(view: AnalyticsView) {
  const parts = view.waits.partitions;
  if (!parts.length || view.waits.start_1m == null) return null;
  const byDay = parts.reduce((best, p) => (p.buckets[4] > best.buckets[4] ? p : best));
  if (byDay.buckets[4] > 0) return { worst: byDay, start1m: view.waits.start_1m, byP90: false };
  const byP90 = parts.reduce((best, p) => ((p.p90 ?? 0) > (best.p90 ?? 0) ? p : best));
  return { worst: byP90, start1m: view.waits.start_1m, byP90: true };
}

export function limitStartFinding(view: AnalyticsView) {
  const pool = mainPool(view.limit_start.pools, (p) => p.users.reduce((a, b) => a + b, 0));
  if (!pool) return null;
  const idx = pool.share.map((s, i) => (s == null ? -1 : i)).filter((i) => i >= 0);
  if (idx.length < 2) return null;
  const first = idx[0];
  const last = idx[idx.length - 1];
  return { pool, first, last, a: pool.share[first] as number, b: pool.share[last] as number };
}

export function concentrationFinding(view: AnalyticsView) {
  const c = view.concentration;
  const top = c.groups.filter((g) => g.to <= 20);
  if (!top.length || !c.users || c.half == null) return null;
  const n = top[top.length - 1].to;
  if (n >= c.users) return null;
  return { n, share: top.reduce((a, g) => a + g.share, 0), people: n / c.users, half: c.half };
}

/** Weekly counts over the last `weeks` complete weeks (the running week excluded). */
export function recentWeeks<T>(series: T[], partial: boolean, weeks = 13): T[] {
  const full = partial ? series.slice(0, -1) : series;
  return full.slice(Math.max(0, full.length - weeks));
}

export function usersFinding(view: AnalyticsView) {
  const recent = recentWeeks(view.weekly.users, view.weekly.partial);
  const top = view.weekly.new_users.reduce<{ month: string; users: number } | null>(
    (best, m) => (!best || m.users > best.users ? m : best), null);
  if (!recent.length || !top) return null;
  return { min: Math.min(...recent), max: Math.max(...recent), weeks: recent.length, top };
}

/** Labels for the job-shape buckets, matching backend UNIT_BOUNDS. */
export function shapeLabels(t: TFn, kind: AnalyticsView["kind"]): string[] {
  const keys = kind === "gpu"
    ? ["an.shape.g0", "an.shape.g1", "an.shape.g2"]
    : ["an.shape.c0", "an.shape.c1", "an.shape.c2", "an.shape.c3", "an.shape.c4"];
  return keys.map((k) => t(k as TranslationKey));
}

/** Ordinal ramp steps for n buckets out of the five --an-units-* steps. */
export function unitSteps(n: number): number[] {
  if (n <= 1) return [3];
  return Array.from({ length: n }, (_, i) => Math.round(1 + (i * 4) / (n - 1)));
}
