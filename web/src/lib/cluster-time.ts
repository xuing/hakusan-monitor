/**
 * Slurm prints times in the cluster's zone with no offset
 * ("2026-10-06T23:10:00"). The UI shows them as printed (format.ts's fmtAt
 * slices the string) and computes with clusterMs(), which reads them in the
 * cluster's zone, so a viewer elsewhere sees the cluster's clock and correct
 * durations. The zone is the backend's HM_CLUSTER_TZ, sent with GET
 * /api/site; until the site loads, the viewer's own zone stands in.
 */
import { getSite } from "@/lib/site";

export const clusterTimeZone = (): string | undefined => getSite().time_zone || undefined;

const formats = new Map<string, Intl.DateTimeFormat>();

/** The wall clock in `zone` at an instant, read as if it were UTC. */
function wallMs(ms: number, zone: string): number {
  let fmt = formats.get(zone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: zone, hourCycle: "h23",
      year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
    });
    formats.set(zone, fmt);
  }
  const v: Record<string, number> = {};
  for (const p of fmt.formatToParts(ms)) v[p.type] = Number(p.value);
  return Date.UTC(v.year, v.month - 1, v.day, v.hour, v.minute, v.second);
}

const NAIVE = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::(\d\d))?$/;

/** Epoch ms of a Slurm time; NaN when it is not one. */
export function clusterMs(iso: string | null | undefined, zone = clusterTimeZone()): number {
  const m = NAIVE.exec(iso ?? "");
  if (!m || !zone) return Date.parse(iso ?? "");
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0));
  // subtract the zone's offset at that moment; the second pass settles DST edges
  const first = wall - (wallMs(wall, zone) - wall);
  return wall - (wallMs(first, zone) - first);
}

/** The cluster-local date of an instant: "2026-10-06". */
const clusterDay = (ms: number, zone: string | undefined) =>
  new Date(ms).toLocaleDateString("en-CA", { timeZone: zone });

/** Which cluster-local day a Slurm time falls on: 0 = today, 1 = tomorrow,
 *  2 = anything else (farther out, or already past) — for choosing
 *  "today 02:39" / "tomorrow 02:39" / a numeric date. */
export function clusterDayOffset(iso: string, zone = clusterTimeZone(), nowMs = Date.now()): 0 | 1 | 2 {
  if (!iso) return 2;
  const day = iso.slice(0, 10);
  if (day === clusterDay(nowMs, zone)) return 0;
  if (day === clusterDay(nowMs + 86_400_000, zone)) return 1;
  return 2;
}

/** An instant on the cluster's clock: "23:44", or "10/7 23:44" on another day. */
export function clusterClock(ms: number, zone = clusterTimeZone(), nowMs = Date.now()): string {
  const hm = new Date(ms).toLocaleTimeString("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const day = clusterDay(ms, zone);
  return day === clusterDay(nowMs, zone) ? hm : `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))} ${hm}`;
}

/** Unix epoch -> short cluster-local date-time, 24h (fmtAt's zone and format). */
export const fmtEpoch = (ts: number) =>
  ts
    ? new Date(ts * 1000).toLocaleString(undefined, {
        timeZone: clusterTimeZone(),
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
    : "—";
