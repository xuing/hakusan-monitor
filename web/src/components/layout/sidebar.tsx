import { Mountain } from "lucide-react";
import { NavLink } from "react-router";
import { visibleNav } from "@/lib/nav";
import { useT } from "@/i18n";
import type { TranslationKey } from "@/i18n/en";
import { cn } from "@/lib/utils";

export function Brand({ compact = false }: { compact?: boolean }) {
  const t = useT();
  return (
    <div className={cn("flex items-center gap-2.5", compact ? "justify-center px-0" : "px-2")} title={compact ? t("app.title") : undefined}>
      <div className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-primary to-violet-500 text-background shadow-lg shadow-primary/20">
        <Mountain className="h-4 w-4" strokeWidth={2.5} />
      </div>
      {!compact && (
        <div className="leading-tight">
          <div className="text-sm font-semibold">{t("app.title")}</div>
          <div className="text-xs text-muted-foreground">{t("app.subtitle")}</div>
        </div>
      )}
    </div>
  );
}

const SECTIONS = ["monitor", "raw", "guide"] as const;

/** `compact`: icons only (the folded rail); the label shows on hover. */
export function SidebarNav({ onNavigate, compact = false }: { onNavigate?: () => void; compact?: boolean }) {
  const t = useT();
  return (
    <nav className={cn("flex flex-col", compact ? "gap-3" : "gap-6")}>
      {SECTIONS.map((section) => (
        <div key={section}>
          {compact ? (
            <div aria-hidden className="mx-3 mb-2 border-t border-border/70" />
          ) : (
            <div className="px-3 pb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground/60">
              {t(`nav.section.${section}` as TranslationKey)}
            </div>
          )}
          <ul className="space-y-1">
            {visibleNav().filter((n) => n.section === section).map((item) => {
              const Icon = item.icon;
              return (
                <li key={item.path}>
                  <NavLink
                    to={item.path}
                    end={item.path === "/"}
                    onClick={onNavigate}
                    title={compact ? t(item.labelKey) : undefined}
                    aria-label={compact ? t(item.labelKey) : undefined}
                    className={({ isActive }) =>
                      cn(
                        "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
                        compact && "justify-center px-0",
                        isActive
                          ? "bg-accent font-medium text-accent-foreground"
                          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                      )
                    }
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    {!compact && <span className="whitespace-nowrap">{t(item.labelKey)}</span>}
                  </NavLink>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
