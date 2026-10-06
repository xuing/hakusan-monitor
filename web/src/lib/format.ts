// Pure formatting helpers (no i18n, no React). Times that need the
// cluster's zone are in cluster-time.ts.

export const pct = (x: number | null | undefined, digits = 0) =>
  `${((x ?? 0) * 100).toFixed(digits)}%`;

export const nf = (n: number | null | undefined) => (n ?? 0).toLocaleString();

/** Slurm time strings are cluster-local; format as plain text (no TZ math). */
export const clockOf = (iso: string) => (iso ? iso.slice(11, 16) : ""); // "23:44"
const dateOf = (iso: string) => (iso ? iso.slice(5, 10) : ""); // "06-27"
export const fmtAt = (iso: string) => (iso ? `${dateOf(iso)} ${clockOf(iso)}` : "—");

/** Slurm duration string -> two-unit form so the magnitude is unmistakable:
 * "1-13:17:04" -> "1d 13h", "2:27:53" -> "2h 27m", "5:09" -> "5m 9s", "0:42" -> "42s".
 * Non-durations ("UNLIMITED", "INVALID", "N/A") pass through untouched. */
export function fmtDurUnits(raw: string): string {
  if (!raw) return "";
  if (!/^(\d+-)?\d+(:\d+)+$/.test(raw)) return raw;
  const sec = parseDur(raw);
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (d > 0) return h ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return s ? `${m}m ${s}s` : `${m}m`;
  return `${s}s`;
}

/** MiB -> human. Slurm reports memory in MiB and its "G" suffix is GiB
 *  (--mem=458G = 469,070 MiB), so the binary unit is labelled as such —
 *  "458 GB" read as decimal would be 492 GB. */
export const fmtMB = (mb: number | null | undefined) => {
  const v = mb ?? 0;
  if (v >= 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} TiB`;
  if (v >= 1024) return `${(v / 1024).toFixed(0)} GiB`;
  return `${v} MiB`;
};

/** Seconds since a unix timestamp, clamped at 0. */
export const secondsSince = (ts: number) => Math.max(0, Date.now() / 1000 - ts);

/** Slurm duration ("30:00", "2:00:00", "7-00:00:00") -> seconds. 0 if unparseable. */
export function parseDur(s: string): number {
  if (!s || (!s.includes(":") && !s.includes("-"))) return 0;
  let days = 0;
  let rest = s;
  if (s.includes("-")) {
    const [d, r] = s.split("-", 2);
    days = parseInt(d, 10) || 0;
    rest = r;
  }
  const parts = rest.split(":").map((x) => parseInt(x, 10) || 0);
  while (parts.length < 3) parts.unshift(0); // -> [h, m, s]
  const [h, m, sec] = parts.slice(-3);
  return days * 86400 + h * 3600 + m * 60 + sec;
}

/** Seconds -> compact total ("7d", "5h 12m", "3m"). */
export function fmtDur(sec: number): string {
  sec = Math.max(0, Math.floor(sec));
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return h ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

/** Seconds -> live countdown clock ("6d 5:12:33", "2:21:09", "0:03:45"). */
export function fmtCountdown(sec: number): string {
  sec = Math.max(0, Math.floor(sec));
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const hms = `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return d > 0 ? `${d}d ${hms}` : hms;
}

