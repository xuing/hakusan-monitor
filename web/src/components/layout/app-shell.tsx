import { useState } from "react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { Outlet } from "react-router";
import { useT } from "@/i18n";
import { cn } from "@/lib/utils";
import { AppFooter } from "./app-footer";
import { Brand, SidebarNav } from "./sidebar";
import { Topbar } from "./topbar";

const KEY = "hm_sidebar";

export function AppShell() {
  const t = useT();
  // folded to an icon rail for laptop screens; remembered per viewer
  const [folded, setFolded] = useState(() => {
    try {
      return localStorage.getItem(KEY) === "folded";
    } catch {
      return false;
    }
  });
  const toggle = () => {
    setFolded(!folded);
    try {
      localStorage.setItem(KEY, folded ? "open" : "folded");
    } catch {
      /* storage unavailable: the choice lasts this visit */
    }
  };
  const ToggleIcon = folded ? PanelLeftOpen : PanelLeftClose;
  return (
    <div className="min-h-svh">
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-30 hidden flex-col border-r border-border bg-card/40 py-4 transition-[width] duration-200 lg:flex",
          folded ? "w-16 px-2" : "w-60 px-3",
        )}
      >
        <Brand compact={folded} />
        <div className="mt-6 flex-1 overflow-y-auto overflow-x-hidden">
          <SidebarNav compact={folded} />
        </div>
        <button
          type="button"
          onClick={toggle}
          aria-label={t(folded ? "nav.expand" : "nav.collapse")}
          title={t(folded ? "nav.expand" : "nav.collapse")}
          className={cn(
            "mt-2 flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground",
            folded && "justify-center px-0",
          )}
        >
          <ToggleIcon className="h-4 w-4 shrink-0" />
          {!folded && <span className="whitespace-nowrap">{t("nav.collapse")}</span>}
        </button>
      </aside>

      <div className={cn("flex min-h-svh flex-col transition-[padding] duration-200", folded ? "lg:pl-16" : "lg:pl-60")}>
        <Topbar />
        <main className="mx-auto w-full max-w-[1920px] flex-1 animate-fade-in px-4 py-6">
          <Outlet />
        </main>
        <AppFooter />
      </div>
    </div>
  );
}
