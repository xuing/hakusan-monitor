import { Skeleton } from "@/components/ui/skeleton";

/** Loading placeholder shaped like a data table (toolbar + rows). */
export function TableSkeleton({ rows = 12 }: { rows?: number }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Skeleton className="h-9 w-56" />
        <Skeleton className="ml-auto h-8 w-24" />
      </div>
      <div className="overflow-hidden rounded-xl border border-border">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 border-b border-border px-4 py-3 last:border-0">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-4 w-16" />
            <Skeleton className="hidden h-4 w-40 sm:block" />
            <Skeleton className="hidden h-4 w-24 md:block" />
            <Skeleton className="ml-auto h-4 w-16" />
          </div>
        ))}
      </div>
    </div>
  );
}
