import { useEffect, useState } from "react";
import { Menu } from "lucide-react";
import { useLocation } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useLive } from "@/hooks/live-context";
import { useT } from "@/i18n";
import { FILTERED_PATHS, NAV } from "@/lib/nav";
import { LangSwitcher } from "./lang-switcher";
import { LiveIndicator } from "./live-indicator";
import { ResourceFilterChips } from "./resource-filter";
import { Brand, SidebarNav } from "./sidebar";
import { ThemeToggle } from "./theme-toggle";

export function Topbar() {
  const t = useT();
  const { snap } = useLive();
  const { pathname } = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const current = NAV.find((n) => n.path === pathname) ?? NAV[0];
  const showFilter = FILTERED_PATHS.has(pathname);
  const pageTitle = t(current.labelKey);

  useEffect(() => {
    document.title = `${pageTitle} · ${t("app.title")}`;
  }, [pageTitle, t]);

  return (
    <header className="sticky top-0 z-20 border-b border-border bg-background/80 backdrop-blur">
      <div className="flex items-center gap-3 px-4 py-3">
        <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
          <SheetTrigger
            aria-label={t("app.title")}
            className="-ml-1 rounded-md p-1 text-muted-foreground hover:text-foreground lg:hidden"
          >
            <Menu className="h-5 w-5" />
          </SheetTrigger>
          <SheetContent side="left" className="w-64 border-border bg-card">
            <SheetTitle className="sr-only">{t("app.title")}</SheetTitle>
            <div className="pt-2">
              <Brand />
              <div className="mt-6">
                <SidebarNav onNavigate={() => setMenuOpen(false)} />
              </div>
            </div>
          </SheetContent>
        </Sheet>

        <div className="min-w-0">
          <h1 className="truncate text-base font-semibold">{pageTitle}</h1>
          <p className="hidden truncate text-xs text-muted-foreground sm:block">{t(current.descKey)}</p>
        </div>

        <div className="ml-auto flex items-center gap-3">
          {snap && (
            <Badge variant="outline" className="hidden font-mono text-xs font-normal text-muted-foreground md:inline-flex">
              {snap.cluster} · slurm {snap.slurm_version}
            </Badge>
          )}
          <LiveIndicator />
          <ThemeToggle />
          <LangSwitcher />
        </div>
      </div>

      {showFilter && (
        <div className="flex items-center gap-2 px-4 pb-3">
          <span className="hidden text-xs text-muted-foreground sm:inline">{t("filter.label")}:</span>
          <ResourceFilterChips />
        </div>
      )}
    </header>
  );
}
