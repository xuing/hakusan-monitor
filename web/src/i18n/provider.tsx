import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { en, type TranslationKey } from "./en";
import { DICTS, isLang, type Lang, type TFn } from "./core";
import { I18nContext } from "./context";
import { SITE_LOADED_EVENT } from "@/lib/site";

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
  // bumped when the site's text lands after the first render (lib/site.ts)
  const [siteVersion, setSiteVersion] = useState(0);

  useEffect(() => {
    const bump = () => setSiteVersion((n) => n + 1);
    window.addEventListener(SITE_LOADED_EVENT, bump);
    return () => window.removeEventListener(SITE_LOADED_EVENT, bump);
  }, []);

  useEffect(() => {
    // BCP 47 tag: zh-CN so the browser picks Simplified Han glyph forms
    document.documentElement.lang = lang === "zh" ? "zh-CN" : lang;
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

  // a new siteVersion re-renders every consumer: the site's text changed DICTS in place
  const value = useMemo(() => ({ lang, setLang, t, siteVersion }), [lang, setLang, t, siteVersion]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export type { TranslationKey };
