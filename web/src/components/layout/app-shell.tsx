import { Outlet } from "react-router-dom";
import { AppFooter } from "./app-footer";
import { Brand, SidebarNav } from "./sidebar";
import { Topbar } from "./topbar";

export function AppShell() {
  return (
    <div className="min-h-svh">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-border bg-card/40 px-3 py-4 lg:flex">
        <Brand />
        <div className="mt-6 flex-1 overflow-y-auto">
          <SidebarNav />
        </div>
      </aside>

      <div className="flex min-h-svh flex-col lg:pl-60">
        <Topbar />
        <main className="mx-auto w-full max-w-[1920px] flex-1 animate-fade-in px-4 py-6">
          <Outlet />
        </main>
        <AppFooter />
      </div>
    </div>
  );
}
