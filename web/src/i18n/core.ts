import { en, type TranslationKey } from "./en";
import { ja } from "./ja";
import { zh } from "./zh";

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

/** Localized hardware-pool label, falling back to the id. */
export function poolLabel(t: TFn, id: string): string {
  const key = `pool.${id}` as TranslationKey;
  const value = t(key);
  return value === key ? id : value;
}
