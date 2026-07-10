import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { en, type TranslationKey } from "./en";
import { DICTS, isLang, type Lang, type TFn } from "./core";
import { I18nContext } from "./context";

function detectLang(): Lang {
  const saved = localStorage.getItem("hm_lang");
  if (saved && isLang(saved)) return saved;
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

  const setLang = useCallback((next: Lang) => {
    localStorage.setItem("hm_lang", next);
    setLangState(next);
  }, []);

  const t = useCallback<TFn>((key, vars) => {
    let value = DICTS[lang][key] ?? en[key] ?? key;
    if (vars) {
      for (const name in vars) value = value.replaceAll(`{${name}}`, String(vars[name]));
    }
    return value;
  }, [lang]);

  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export type { TranslationKey };
