import { cn } from "@/lib/utils";

/** Pulsing block shown while a chart's data is on its first fetch. */
export function ChartPlaceholder({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-lg bg-muted/40", className ?? "h-40")} />;
}
