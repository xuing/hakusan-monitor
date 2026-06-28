import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { en, type TranslationKey } from "./en";
import { ja } from "./ja";
import { zh } from "./zh";

export type { TranslationKey } from "./en";

export const LANGS = ["ja", "en", "zh"] as const;
export type Lang = (typeof LANGS)[number];

const DICTS: Record<Lang, Record<TranslationKey, string>> = { en, ja, zh };
const isLang = (s: string): s is Lang => (LANGS as readonly string[]).includes(s);

export type TFn = (key: TranslationKey, vars?: Record<string, string | number>) => string;

interface I18nValue {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: TFn;
}

const I18nContext = createContext<I18nValue | null>(null);

function detectLang(): Lang {
  const saved = localStorage.getItem("hm_lang");
  if (saved && isLang(saved)) return saved; // explicit choice wins
  // otherwise follow the browser's language preference list
  const prefs = navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const pref of prefs) {
    const code = pref.slice(0, 2);
    if (isLang(code)) return code;
  }
  return "en";
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(detectLang);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const setLang = useCallback((l: Lang) => {
    localStorage.setItem("hm_lang", l);
    setLangState(l);
  }, []);

  const t = useCallback<TFn>(
    (key, vars) => {
      let s = DICTS[lang][key] ?? en[key] ?? key;
      if (vars) for (const k in vars) s = s.replaceAll(`{${k}}`, String(vars[k]));
      return s;
    },
    [lang],
  );

  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within I18nProvider");
  return ctx;
}

export const useT = (): TFn => useI18n().t;

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
  const v = t(key);
  return v === key ? id : v;
}
