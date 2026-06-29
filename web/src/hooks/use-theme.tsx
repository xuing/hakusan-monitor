import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type Theme = "dark" | "light";

interface ThemeValue {
  theme: Theme;
  setTheme: (t: Theme) => void;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeValue | null>(null);

const THEME_KEY = "hm_theme";

function savedTheme(): Theme | null {
  const saved = localStorage.getItem(THEME_KEY);
  return saved === "dark" || saved === "light" ? saved : null;
}

function systemTheme(): Theme {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

const detectTheme = (): Theme => savedTheme() ?? systemTheme();

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(detectTheme);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  useEffect(() => {
    if (savedTheme()) return;
    const query = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!query) return;
    const sync = () => setThemeState(query.matches ? "dark" : "light");
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  const setTheme = useCallback((t: Theme) => {
    localStorage.setItem(THEME_KEY, t);
    setThemeState(t);
  }, []);
  const toggle = useCallback(() => setThemeState((p) => {
    const next = p === "dark" ? "light" : "dark";
    localStorage.setItem(THEME_KEY, next);
    return next;
  }), []);

  const value = useMemo(() => ({ theme, setTheme, toggle }), [theme, setTheme, toggle]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
