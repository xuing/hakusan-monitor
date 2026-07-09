import { Mountain } from "lucide-react";
import { NavLink } from "react-router-dom";
import { NAV } from "@/lib/nav";
import { useT } from "@/i18n";
import type { TranslationKey } from "@/i18n/en";
import { cn } from "@/lib/utils";

export function Brand() {
  const t = useT();
  return (
    <div className="flex items-center gap-2.5 px-2">
      <div className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-primary to-violet-500 text-background shadow-lg shadow-primary/20">
        <Mountain className="h-4 w-4" strokeWidth={2.5} />
      </div>
      <div className="leading-tight">
        <div className="text-sm font-semibold">{t("app.title")}</div>
        <div className="text-xs text-muted-foreground">{t("app.subtitle")}</div>
      </div>
    </div>
  );
}

const SECTIONS = ["monitor", "raw", "guide"] as const;

export function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const t = useT();
  return (
    <nav className="flex flex-col gap-6">
      {SECTIONS.map((section) => (
        <div key={section}>
          <div className="px-3 pb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground/60">
            {t(`nav.section.${section}` as TranslationKey)}
          </div>
          <ul className="space-y-1">
            {NAV.filter((n) => n.section === section).map((item) => {
              const Icon = item.icon;
              return (
                <li key={item.path}>
                  <NavLink
                    to={item.path}
                    end={item.path === "/"}
                    onClick={onNavigate}
                    className={({ isActive }) =>
                      cn(
                        "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
                        isActive
                          ? "bg-accent font-medium text-accent-foreground"
                          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                      )
                    }
                  >
                    <Icon className="h-4 w-4" />
                    {t(item.labelKey)}
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
