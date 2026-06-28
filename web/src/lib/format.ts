// Pure formatting helpers (no i18n, no React).

export const pct = (x: number | null | undefined, digits = 0) =>
  `${((x ?? 0) * 100).toFixed(digits)}%`;

export const nf = (n: number | null | undefined) => (n ?? 0).toLocaleString();

/** Slurm time strings are cluster-local; format as plain text (no TZ math). */
export const clockOf = (iso: string) => (iso ? iso.slice(11, 16) : ""); // "23:44"
export const dateOf = (iso: string) => (iso ? iso.slice(5, 10) : ""); // "06-27"
export const fmtAt = (iso: string) => (iso ? `${dateOf(iso)} ${clockOf(iso)}` : "—");

/** "2:27:53" -> "2:27" ; "1-13:17:04" -> "1-13:17" */
export const fmtLeft = (s: string) => {
  if (!s) return "";
  const p = s.split(":");
  return p.length >= 3 ? p.slice(0, 2).join(":") : s;
};

/** MB -> human (the cluster reports memory in MB). */
export const fmtMB = (mb: number | null | undefined) => {
  const v = mb ?? 0;
  if (v >= 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} TB`;
  if (v >= 1024) return `${(v / 1024).toFixed(0)} GB`;
  return `${v} MB`;
};

/** Seconds since a unix timestamp, clamped at 0. */
export const secondsSince = (ts: number) => Math.max(0, Date.now() / 1000 - ts);

/** Unix epoch -> short local date-time (used for absolute timestamps like submit). */
export const fmtEpoch = (ts: number) =>
  ts
    ? new Date(ts * 1000).toLocaleString(undefined, {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";
