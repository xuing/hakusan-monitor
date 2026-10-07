// The quick request's input parsing and slider axes: pure, no React, no i18n.
import { fmtDur } from "@/lib/format";
import { parseWalltimeSec } from "@/lib/slurm";

export interface SliderTick {
  value: number;
  label: string;
  /** dropped below the sm breakpoint, where the track is narrow */
  minor?: boolean;
}

/** A limit in whole GiB, rounded down: never promise memory that isn't there. */
export const fmtGb = (mb: number) => (mb > 0 ? `${Math.floor(mb / 1024)}G` : "");

/** A default in GiB as the slider shows it (rounded). */
/** A size the way the sliders print it: "250G", "1.5T". */
export const fmtSize = (mb: number) => (mb >= 1024 * 1024 ? `${+(mb / 1024 / 1024).toFixed(1)}T` : `${Math.round(mb / 1024)}G`);
export const fmtGbNear = (mb: number) => (mb > 0 ? `${Math.round(mb / 1024)}G` : "");

/** The largest integer in lo..hi a monotone test still passes (fewer
 *  resources never hurt); lo - 1 when none does. */
export function largestPassing(lo: number, hi: number, ok: (v: number) => boolean) {
  if (hi < lo || !ok(lo)) return lo - 1;
  let a = lo;
  let b = hi;
  while (a < b) {
    const m = Math.ceil((a + b) / 2);
    if (ok(m)) a = m;
    else b = m - 1;
  }
  return a;
}

/** Ticks for a linear count axis: the ends plus ~3 round steps between. */
export function linearTicks(lo: number, hi: number): SliderTick[] {
  const steps = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096];
  const step = steps.find((s) => (hi - lo) / s <= 4) ?? steps[steps.length - 1];
  const out: SliderTick[] = [{ value: lo, label: String(lo) }];
  for (let v = Math.ceil((lo + 1) / step) * step; v < hi; v += step) {
    if ((v - lo) / Math.max(hi - lo, 1) > 0.08) out.push({ value: v, label: String(v) });
  }
  out.push({ value: hi, label: String(hi) });
  return out;
}

/** A clicked point on the log core axis as a count a person would ask for:
 *  a power of two when close to one, else a round step for its size. */
export function niceCoreCount(v: number) {
  const p2 = 2 ** Math.round(Math.log2(v));
  if (Math.abs(v - p2) / p2 < 0.12) return Math.max(1, p2);
  const step = v <= 16 ? 1 : v <= 256 ? 8 : 64;
  return Math.max(1, Math.round(v / step) * step);
}

const fmtCount = (v: number) => (v >= 1024 && v % 1024 === 0 ? `${v / 1024}K` : String(v));

/** Ticks for the table's log core axis: powers of four, and the end; the
 *  odd powers of two are minor (hidden on a phone-width bar). */
export function logTicks(max: number) {
  const out = [1, 4, 16, 64, 256, 1024, 4096, 16384]
    .filter((v) => v <= max)
    .map((v) => ({ value: v, label: fmtCount(v), minor: v !== max && (Math.log2(v) % 4 !== 0 || Math.log2(max / v) < 1.5) }));
  // the end gets its own label; ticks within 1.5 octaves of it would touch
  if (max / out[out.length - 1].value >= 1.5) {
    return [...out.filter((tk) => Math.log2(max / tk.value) >= 1.5), { value: max, label: fmtCount(max), minor: false }];
  }
  return out;
}

const WALLTIME_TICKS: [number, string][] = [[600, "10m"], [3600, "1h"], [21600, "6h"], [86400, "1d"], [259200, "3d"], [604800, "7d"], [1209600, "14d"], [1814400, "21d"]];

/** Log-axis ticks for -t: the ends plus round steps, none closer than 15%
 *  of the track to a neighbour (so "3d" never sits on top of "7d"). */
export function walltimeTicks(min: number, max: number): SliderTick[] {
  const pos = (v: number) => Math.log(v / min) / (Math.log(max / min) || 1);
  const out: SliderTick[] = [{ value: min, label: fmtDur(min) }];
  for (const [value, label] of WALLTIME_TICKS) {
    if (value <= min || value >= max) continue;
    if (pos(value) - pos(out[out.length - 1].value) < 0.15 || 1 - pos(value) < 0.15) continue;
    out.push({ value, label });
  }
  out.push({ value: max, label: fmtDur(max) });
  return out;
}

/** Round a dragged walltime to a step a person would type. */
export function quantizeWalltime(sec: number) {
  const step = sec < 7200 ? 300 : sec < 86400 ? 1800 : 3600;
  return Math.max(step, Math.round(sec / step) * step);
}

/** "3d", "12h", "90m", "1d12h" or any Slurm -t form -> seconds (0 = unreadable). */
export function parseHumanTime(text: string) {
  const s = text.trim().toLowerCase();
  if (!s) return 0;
  const m = s.match(/^(?:(\d+)\s*d)?\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?$/);
  if (m && (m[1] || m[2] || m[3])) return Number(m[1] || 0) * 86400 + Number(m[2] || 0) * 3600 + Number(m[3] || 0) * 60;
  return parseWalltimeSec(s);
}

/** A stored selection outside the (new) partition's bounds counts as "no
 *  selection" — clamping it silently would emit a flag the UI no longer
 *  shows. Bounds are two-sided: QOS MinTRES rejects too-small requests. */
export function withinCapInt(value: string, max?: number, min?: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  const n = Math.floor(parsed);
  if (max && n > max) return 0;
  if (min && n < min) return 0;
  return n;
}

export function normalizeMem(value: string) {
  const raw = value.trim().toUpperCase();
  if (!raw) return "";
  const m = raw.match(/^(\d+)([KMGTP])$/);
  if (!m) return "";
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return "";
  return `${Math.floor(n)}${m[2]}`;
}

export function parseMemoryInputMb(value: string) {
  const m = normalizeMem(value).match(/^(\d+)([KMGTP])$/);
  if (!m) return 0;
  const n = Number(m[1]);
  const unit = m[2];
  const mult: Record<string, number> = { K: 1 / 1024, M: 1, G: 1024, T: 1024 * 1024, P: 1024 * 1024 * 1024 };
  return Math.round(n * mult[unit]);
}

export function numberOptions(max: number | undefined, values: number[], min?: number) {
  const limit = max ?? Math.max(...values);
  const floor = min ?? 1;
  const out = new Set(values.filter((n) => n >= floor && n <= limit));
  if (max && max > 0) out.add(max);
  if (min && min > 0 && min <= limit) out.add(min);
  return [...out].sort((a, b) => a - b);
}

