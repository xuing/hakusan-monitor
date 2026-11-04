import { en, type TranslationKey } from "./en";
import { nf } from "@/lib/format";

export type { TranslationKey } from "./en";

/** UI languages: Japanese and English, then the mother tongue of each
 *  country JAIST's international students come from (UK, Zimbabwe and
 *  Nigeria use English), in order of student count. */
export const LANGS = [
  "ja", "en", "zh", "vi", "bn", "th", "id", "hi", "ko", "ur", "zh-Hant",
  "ms", "it", "fr", "pt", "si", "de", "tr", "fil", "my", "ar",
] as const;
export type Lang = (typeof LANGS)[number];
export type TFn = (key: TranslationKey, vars?: Record<string, string | number>) => string;
type Dict = Record<TranslationKey, string>;

/** Native name for the switcher, BCP 47 tag for `<html lang>` and Intl,
 *  and the writing direction. */
export const LANG_META: Record<Lang, { label: string; tag: string; rtl?: true }> = {
  ja: { label: "日本語", tag: "ja" },
  en: { label: "English", tag: "en" },
  zh: { label: "简体中文", tag: "zh-CN" },
  vi: { label: "Tiếng Việt", tag: "vi" },
  bn: { label: "বাংলা", tag: "bn" },
  th: { label: "ไทย", tag: "th" },
  id: { label: "Bahasa Indonesia", tag: "id" },
  hi: { label: "हिन्दी", tag: "hi" },
  ko: { label: "한국어", tag: "ko" },
  ur: { label: "اردو", tag: "ur", rtl: true },
  "zh-Hant": { label: "繁體中文", tag: "zh-TW" },
  ms: { label: "Bahasa Melayu", tag: "ms" },
  it: { label: "Italiano", tag: "it" },
  fr: { label: "Français", tag: "fr" },
  pt: { label: "Português", tag: "pt" },
  si: { label: "සිංහල", tag: "si" },
  de: { label: "Deutsch", tag: "de" },
  tr: { label: "Türkçe", tag: "tr" },
  fil: { label: "Filipino", tag: "fil" },
  my: { label: "မြန်မာ", tag: "my" },
  ar: { label: "العربية", tag: "ar", rtl: true },
};

/** Loaded dictionaries. English is built in (every other language falls
 *  back to it key by key); the rest load on first use. ja and zh are
 *  written by hand; locales/*.json are translated from English and checked
 *  by locales.test.ts. */
export const DICTS: Partial<Record<Lang, Dict>> & { en: Dict } = { en };
export const isLang = (value: string): value is Lang => (LANGS as readonly string[]).includes(value);

const LOADERS: Record<Exclude<Lang, "en">, () => Promise<Dict>> = {
  ja: () => import("./ja").then((m) => m.ja),
  zh: () => import("./zh").then((m) => m.zh),
  vi: () => import("./locales/vi.json").then((m) => m.default as Dict),
  bn: () => import("./locales/bn.json").then((m) => m.default as Dict),
  th: () => import("./locales/th.json").then((m) => m.default as Dict),
  id: () => import("./locales/id.json").then((m) => m.default as Dict),
  hi: () => import("./locales/hi.json").then((m) => m.default as Dict),
  ko: () => import("./locales/ko.json").then((m) => m.default as Dict),
  ur: () => import("./locales/ur.json").then((m) => m.default as Dict),
  "zh-Hant": () => import("./locales/zh-Hant.json").then((m) => m.default as Dict),
  ms: () => import("./locales/ms.json").then((m) => m.default as Dict),
  it: () => import("./locales/it.json").then((m) => m.default as Dict),
  fr: () => import("./locales/fr.json").then((m) => m.default as Dict),
  pt: () => import("./locales/pt.json").then((m) => m.default as Dict),
  si: () => import("./locales/si.json").then((m) => m.default as Dict),
  de: () => import("./locales/de.json").then((m) => m.default as Dict),
  tr: () => import("./locales/tr.json").then((m) => m.default as Dict),
  fil: () => import("./locales/fil.json").then((m) => m.default as Dict),
  my: () => import("./locales/my.json").then((m) => m.default as Dict),
  ar: () => import("./locales/ar.json").then((m) => m.default as Dict),
};

const loadHooks: ((lang: Lang) => void)[] = [];
/** Run `fn` on every dictionary as it loads (lib/site.ts fills in the
 *  site's name and text). */
export function onDictLoaded(fn: (lang: Lang) => void) {
  loadHooks.push(fn);
}

/** Load `lang`'s dictionary once; later calls resolve at once. */
export async function loadLang(lang: Lang): Promise<void> {
  if (DICTS[lang]) return;
  const dict = await LOADERS[lang as Exclude<Lang, "en">]();
  if (DICTS[lang]) return;
  DICTS[lang] = { ...dict };
  for (const fn of loadHooks) fn(lang);
}

/** The UI language for one browser language tag ("zh-TW" → zh-Hant,
 *  "tl" → fil), or null when there is none. */
export function matchLang(tag: string): Lang | null {
  const lower = tag.toLowerCase();
  const [base] = lower.split(/[-_]/);
  if (base === "zh") return /hant|-tw|-hk|-mo/.test(lower) ? "zh-Hant" : "zh";
  const alias: Record<string, Lang> = { tl: "fil", in: "id", zsm: "ms" };
  const lang = alias[base] ?? base;
  return isLang(lang) ? lang : null;
}

/** The first browser language the UI has, else English. */
export function browserLang(prefs: readonly string[] = navigator.languages?.length ? navigator.languages : [navigator.language]): Lang {
  for (const pref of prefs) {
    const lang = pref && matchLang(pref);
    if (lang) return lang;
  }
  return "en";
}

/** The text for `key`, or "" where no dictionary defines it (site-specific
 *  keys such as `policy.<partition>.desc`). */
export function tOptional(t: TFn, key: string): string {
  const text = t(key as TranslationKey);
  return text === key ? "" : text;
}


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
