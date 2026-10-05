import { en, type TranslationKey } from "./en";
import { ja } from "./ja";
import { zh } from "./zh";
import { nf } from "@/lib/format";

export type { TranslationKey } from "./en";

export const LANGS = ["ja", "en", "zh"] as const;
export type Lang = (typeof LANGS)[number];
export type TFn = (key: TranslationKey, vars?: Record<string, string | number>) => string;

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

/** Localized hardware-pool label, falling back to the id. */
export function poolLabel(t: TFn, id: string): string {
  const key = `pool.${id}` as TranslationKey;
  const value = t(key);
  return value === key ? id : value;
}
