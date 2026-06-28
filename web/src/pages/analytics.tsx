import { TrendsPanel } from "@/components/analytics/trends-panel";
import { UsagePanel } from "@/components/analytics/usage-panel";

export default function AnalyticsPage() {
  return (
    <div className="grid gap-4">
      <UsagePanel />
      <TrendsPanel />
    </div>
  );
}
