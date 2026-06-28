import { lazy, Suspense } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { AppShell } from "@/components/layout/app-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { LiveProvider } from "@/hooks/use-live";
import { ResourceFilterProvider } from "@/hooks/use-resource-filter";
import { ThemeProvider } from "@/hooks/use-theme";
import { I18nProvider } from "@/i18n";

// Code-split each page so the heavy chart code loads only when needed.
const OverviewPage = lazy(() => import("@/pages/overview"));
const PartitionsPage = lazy(() => import("@/pages/partitions"));
const AnalyticsPage = lazy(() => import("@/pages/analytics"));
const LoginNodesPage = lazy(() => import("@/pages/login-nodes"));
const NodesPage = lazy(() => import("@/pages/nodes"));
const JobsPage = lazy(() => import("@/pages/jobs"));
const SlurmGuidePage = lazy(() => import("@/pages/slurm-guide"));
const ContainersPage = lazy(() => import("@/pages/containers"));

const PageFallback = () => <Skeleton className="h-96 rounded-xl" />;

export default function App() {
  return (
    <ThemeProvider>
    <I18nProvider>
      <LiveProvider>
        <ResourceFilterProvider>
          <BrowserRouter>
            <Routes>
              <Route element={<AppShell />}>
                <Route
                  path="/"
                  element={
                    <Suspense fallback={<PageFallback />}>
                      <OverviewPage />
                    </Suspense>
                  }
                />
                <Route
                  path="/partitions"
                  element={
                    <Suspense fallback={<PageFallback />}>
                      <PartitionsPage />
                    </Suspense>
                  }
                />
                <Route
                  path="/analytics"
                  element={
                    <Suspense fallback={<PageFallback />}>
                      <AnalyticsPage />
                    </Suspense>
                  }
                />
                <Route
                  path="/login-nodes"
                  element={
                    <Suspense fallback={<PageFallback />}>
                      <LoginNodesPage />
                    </Suspense>
                  }
                />
                <Route
                  path="/nodes"
                  element={
                    <Suspense fallback={<PageFallback />}>
                      <NodesPage />
                    </Suspense>
                  }
                />
                <Route
                  path="/jobs"
                  element={
                    <Suspense fallback={<PageFallback />}>
                      <JobsPage />
                    </Suspense>
                  }
                />
                <Route
                  path="/slurm"
                  element={
                    <Suspense fallback={<PageFallback />}>
                      <SlurmGuidePage />
                    </Suspense>
                  }
                />
                <Route
                  path="/containers"
                  element={
                    <Suspense fallback={<PageFallback />}>
                      <ContainersPage />
                    </Suspense>
                  }
                />
                <Route path="*" element={<Suspense fallback={<PageFallback />}><OverviewPage /></Suspense>} />
              </Route>
            </Routes>
          </BrowserRouter>
        </ResourceFilterProvider>
      </LiveProvider>
    </I18nProvider>
    </ThemeProvider>
  );
}
