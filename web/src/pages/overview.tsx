import { KpiCards } from "@/components/dashboard/kpi-cards";
import { NodesDown } from "@/components/dashboard/nodes-down";
import { PoolDetail } from "@/components/dashboard/pool-detail";
import { QueueInsights } from "@/components/dashboard/queue-insights";
import { ReleasesPanel } from "@/components/dashboard/releases-panel";
import { ResourcePools } from "@/components/dashboard/resource-pools";
import { TopUsers } from "@/components/dashboard/top-users";
import { Skeleton } from "@/components/ui/skeleton";
import { LivePending } from "@/components/common/live-pending";
import { useLive } from "@/hooks/live-context";
import { useResourceFilter } from "@/hooks/resource-filter-context";

export default function OverviewPage() {
  const { snap } = useLive();
  const { filter } = useResourceFilter();
  if (!snap) return <LivePending fallback={<LoadingSkeleton />} />;

  return (
    <div className="space-y-4">
      <KpiCards />
      <ResourcePools />
      {filter !== "all" && <PoolDetail />}
      <div className="grid gap-4 lg:grid-cols-12">
        <div
          className={filter === "all"
            ? "lg:col-span-5 lg:min-h-0 lg:overflow-hidden lg:[contain:size] xl:col-span-4"
            : "lg:col-span-12"}
        >
          <ReleasesPanel />
        </div>
        {filter === "all" && (
          <div className="lg:col-span-7 xl:col-span-8">
            <QueueInsights />
          </div>
        )}
        <div className="lg:col-span-6">
          <NodesDown />
        </div>
        <div className="lg:col-span-6">
          <TopUsers />
        </div>
      </div>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24 rounded-xl" />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-40 rounded-xl" />
        ))}
      </div>
    </div>
  );
}
