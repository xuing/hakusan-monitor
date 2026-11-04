import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DirectionProvider } from "@radix-ui/react-direction";
import { type TranslationKey } from "./en";
import { browserLang, DICTS, isLang, LANG_META, loadLang, type Lang, type TFn } from "./core";
import { I18nContext, type LangChoice } from "./context";
import { SITE_LOADED_EVENT } from "@/lib/site";

const KEY = "hm_lang";

/** The language the reader picked; "auto" (nothing saved) follows the browser. */
function savedChoice(): LangChoice {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved && isLang(saved)) return saved;
  } catch { /* storage blocked: follow the browser */ }
  return "auto";
}

/** The language to show before the first render (main.tsx loads it first). */
export function initialLang(): Lang {
  const choice = savedChoice();
  return choice === "auto" ? browserLang() : choice;
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [choice, setChoice] = useState<LangChoice>(savedChoice);
  const [lang, setLangState] = useState<Lang>(initialLang);
  // bumped when the site's text lands after the first render (lib/site.ts)
  const [siteVersion, setSiteVersion] = useState(0);

  useEffect(() => {
    const bump = () => setSiteVersion((n) => n + 1);
    window.addEventListener(SITE_LOADED_EVENT, bump);
    return () => window.removeEventListener(SITE_LOADED_EVENT, bump);
  }, []);

  // show `next` once its dictionary is in; until then the old language stays.
  // Only the latest request counts: a slow earlier load must not win.
  const request = useRef(0);
  const show = useCallback((next: Lang) => {
    const id = ++request.current;
    loadLang(next).then(
      () => { if (id === request.current) setLangState(next); },
      () => { if (id === request.current) setLangState("en"); },
    );
  }, []);

  // "auto": the browser's language list can change while the page is open
  useEffect(() => {
    if (choice !== "auto") return;
    const follow = () => show(browserLang());
    window.addEventListener("languagechange", follow);
    return () => window.removeEventListener("languagechange", follow);
  }, [choice, show]);

  useLayoutEffect(() => {
    const root = document.documentElement;
    // BCP 47 tag: zh-CN / zh-TW so the browser picks the right Han glyph forms
    root.lang = LANG_META[lang].tag;
    root.dir = LANG_META[lang].rtl ? "rtl" : "ltr";
  }, [lang]);

  const setLang = useCallback((next: LangChoice) => {
    try {
      if (next === "auto") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, next);
    } catch { /* storage blocked: the choice lasts for this page */ }
    setChoice(next);
    show(next === "auto" ? browserLang() : next);
  }, [show]);

  const t = useCallback<TFn>((key, vars) => {
    let value = DICTS[lang]?.[key] ?? DICTS.en[key] ?? key;
    if (vars) {
      for (const name in vars) value = value.replaceAll(`{${name}}`, String(vars[name]));
    }
    return value;
  }, [lang]);

  // a new siteVersion re-renders every consumer: the site's text changed DICTS in place
  const value = useMemo(() => ({ lang, choice, setLang, t, siteVersion }), [lang, choice, setLang, t, siteVersion]);
  // menus and tooltips (Radix) render in a portal and read the direction from here
  return (
    <I18nContext.Provider value={value}>
      <DirectionProvider dir={LANG_META[lang].rtl ? "rtl" : "ltr"}>{children}</DirectionProvider>
    </I18nContext.Provider>
  );
}

export type { TranslationKey };
