import { en, type TranslationKey } from "./en";
import { ja } from "./ja";
import { zh } from "./zh";
import { nf } from "@/lib/format";

export type { TranslationKey } from "./en";

export const LANGS = ["ja", "en", "zh"] as const;
export type Lang = (typeof LANGS)[number];
export type TFn = (key: TranslationKey, vars?: Record<string, string | number>) => string;

/** The text for `key`, or "" where no dictionary defines it (site-specific
 *  keys such as `policy.<partition>.desc`). */
export function tOptional(t: TFn, key: string): string {
  const text = t(key as TranslationKey);
  return text === key ? "" : text;
}

export const DICTS: Record<Lang, Record<TranslationKey, string>> = { en, ja, zh };
export const isLang = (value: string): value is Lang => (LANGS as readonly string[]).includes(value);

/** Resolve a raw Slurm reason to a localized label (full key, then first word, else raw). */
export function reasonLabel(t: TFn, raw: string): string {
  if (!raw) return "";
  const full = `reason.${raw}` as TranslationKey;
  if (t(full) !== full) return t(full);
  const word = raw.split(/[\s_]/)[0];
  const key = `reason.${word}` as TranslationKey;
  return t(key) === key ? raw : t(key);
}

/** What a raw Slurm reason means (Slurm's job reason codes), localized:
 *  full key, then first word ("Nodes required for job are DOWN, …"); "" when
 *  the code has no description. */
export function reasonDescription(t: TFn, raw: string): string {
  if (!raw) return "";
  for (const key of [`reason.${raw}.desc`, `reason.${raw.split(/[\s_]/)[0]}.desc`] as TranslationKey[]) {
    if (t(key) !== key) return t(key);
  }
  return "";
}

/** A CPU core count with its unit spelled out: "7 核", "7 cores", "1 core",
 *  "7 コア" — a bare "7c" means nothing to someone new to Slurm. */
export function coresText(t: TFn, n: number): string {
  return `${nf(n)} ${t(n === 1 ? "unit.core" : "unit.cores")}`;
}

/** A duration in words — "5 天", "12 小时 30 分钟", "1 day", "30 min" — for
 *  sentences, tables and chips; slider axes and value boxes keep "5d". */
export function durText(t: TFn, sec: number): string {
  sec = Math.max(0, Math.floor(sec));
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const part = (n: number, unit: "d" | "h" | "m") => t(`dur.${unit}${n === 1 ? "1" : ""}` as TranslationKey, { n });
  if (d > 0) return h ? `${part(d, "d")} ${part(h, "h")}` : part(d, "d");
  if (h > 0) return m ? `${part(h, "h")} ${part(m, "m")}` : part(h, "h");
  return part(m, "m");
}

/** A Slurm limit label ("7d", "30m", "12h") in words; anything else as is. */
export function wallText(t: TFn, wall: string | null | undefined): string {
  const m = String(wall ?? "").match(/^(\d+)([mhd])$/);
  if (!m) return wall ?? "";
  return durText(t, Number(m[1]) * (m[2] === "d" ? 86400 : m[2] === "h" ? 3600 : 60));
}

/** A pool's title: its label plus, for a GPU pool, each card's memory
 *  ("A40 48GB", "H100 80GB" — that label already carries it). */
export function poolTitle(t: TFn, pool: { id: string; gpu?: { mem_gb: number | null } | null } | undefined, id = pool?.id ?? ""): string {
  const label = poolLabel(t, id);
  const mem = pool?.gpu?.mem_gb;
  return mem && !/\d\s*GB/i.test(label) ? `${label} ${mem}GB` : label;
}

/** Localized hardware-pool label, falling back to the id. */
export function poolLabel(t: TFn, id: string): string {
  const key = `pool.${id}` as TranslationKey;
  const value = t(key);
  return value === key ? id : value;
}
