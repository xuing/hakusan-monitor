import { createContext, useContext } from "react";
import type { Lang, TFn } from "./core";

/** A language, or "auto": follow the browser's language list. */
export type LangChoice = Lang | "auto";

export interface I18nValue {
  /** the language on screen */
  lang: Lang;
  /** what the reader picked */
  choice: LangChoice;
  setLang: (lang: LangChoice) => void;
  t: TFn;
  /** bumped when the site's text arrives after the first render */
  siteVersion: number;
}

export const I18nContext = createContext<I18nValue | null>(null);

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within I18nProvider");
  return ctx;
}

export const useT = (): TFn => useI18n().t;
