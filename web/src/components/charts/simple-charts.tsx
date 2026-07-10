import { useId } from "react";
import { cn } from "@/lib/utils";

type Datum = Record<string, string | number>;

const PALETTE: Record<string, string> = {
  blue: "#1769e0",
  violet: "#7259c7",
  amber: "#b66a00",
  emerald: "#16855b",
  rose: "#cf3f5b",
  cyan: "#087e8b",
  slate: "#52647c",
};

interface ChartProps {
  data: Datum[];
  index: string;
  categories: string[];
  colors?: string[];
  valueFormatter?: (value: number) => string;
  showLegend?: boolean;
  startEndOnly?: boolean;
  yAxisWidth?: number;
  className?: string;
}

const size = { width: 760, height: 230, left: 46, right: 14, top: 18, bottom: 30 };

/** Small dependency-free area chart for monitor trends. */
export function AreaChart({
  data,
  index,
  categories,
  colors = ["blue"],
  valueFormatter = (value) => String(Math.round(value)),
  showLegend = true,
  className,
}: ChartProps) {
  const id = useId().replaceAll(":", "");
  const values = data.flatMap((row) => categories.map((category) => number(row[category])));
  const max = niceMax(Math.max(0, ...values));
  const chartW = size.width - size.left - size.right;
  const chartH = size.height - size.top - size.bottom;
  const x = (i: number) => size.left + (data.length <= 1 ? chartW / 2 : (i / (data.length - 1)) * chartW);
  const y = (value: number) => size.top + chartH - (value / max) * chartH;

  return (
    <figure className={cn("flex min-h-0 flex-col", className)} aria-label={categories.join(", ")}>
      {showLegend && (
        <figcaption className="mb-1 flex flex-wrap justify-end gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {categories.map((category, i) => (
            <span key={category} className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full" style={{ background: color(colors[i]) }} aria-hidden />
              {category}
            </span>
          ))}
        </figcaption>
      )}
      <svg className="min-h-0 flex-1 overflow-visible" viewBox={`0 0 ${size.width} ${size.height}`} role="img">
        <title>{categories.join(", ")}</title>
        <defs>
          {categories.map((category, i) => (
            <linearGradient key={category} id={`${id}-${i}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor={color(colors[i])} stopOpacity="0.24" />
              <stop offset="1" stopColor={color(colors[i])} stopOpacity="0.02" />
            </linearGradient>
          ))}
        </defs>
        {[0, .5, 1].map((ratio) => {
          const yy = size.top + chartH * (1 - ratio);
          return (
            <g key={ratio}>
              <line x1={size.left} y1={yy} x2={size.width - size.right} y2={yy} stroke="currentColor" className="text-border" strokeWidth="1" />
              <text x={size.left - 7} y={yy + 4} textAnchor="end" className="fill-muted-foreground text-xs">
                {valueFormatter(max * ratio)}
              </text>
            </g>
          );
        })}
        {categories.map((category, categoryIndex) => {
          const points = data.map((row, i) => [x(i), y(number(row[category]))] as const);
          if (!points.length) return null;
          const line = points.map(([px, py], i) => `${i ? "L" : "M"}${px},${py}`).join(" ");
          const area = `${line} L${points.at(-1)![0]},${size.top + chartH} L${points[0][0]},${size.top + chartH} Z`;
          const stroke = color(colors[categoryIndex]);
          return (
            <g key={category}>
              <path d={area} fill={`url(#${id}-${categoryIndex})`} />
              <path d={line} fill="none" stroke={stroke} strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round" />
              {points.map(([px, py], i) => (
                <circle key={i} cx={px} cy={py} r={data.length > 80 ? 1.2 : 2.2} fill={stroke}>
                  <title>{`${data[i][index]} · ${category}: ${valueFormatter(number(data[i][category]))}`}</title>
                </circle>
              ))}
            </g>
          );
        })}
        {data.length > 0 && (
          <>
            <text x={size.left} y={size.height - 7} className="fill-muted-foreground text-xs">{String(data[0][index])}</text>
            <text x={size.width - size.right} y={size.height - 7} textAnchor="end" className="fill-muted-foreground text-xs">
              {String(data.at(-1)![index])}
            </text>
          </>
        )}
      </svg>
    </figure>
  );
}

/** Small dependency-free bar chart used by the visit summary. */
export function BarChart({
  data,
  index,
  categories,
  colors = ["blue"],
  valueFormatter = (value) => String(Math.round(value)),
  className,
}: ChartProps) {
  const category = categories[0];
  const max = niceMax(Math.max(0, ...data.map((row) => number(row[category]))));
  const chartW = size.width - size.left - size.right;
  const chartH = size.height - size.top - size.bottom;
  const slot = chartW / Math.max(data.length, 1);
  const barW = Math.max(2, Math.min(20, slot * .7));
  return (
    <figure className={cn("min-h-0", className)} aria-label={category}>
      <svg className="h-full w-full overflow-visible" viewBox={`0 0 ${size.width} ${size.height}`} role="img">
        <title>{category}</title>
        {[0, .5, 1].map((ratio) => {
          const yy = size.top + chartH * (1 - ratio);
          return (
            <g key={ratio}>
              <line x1={size.left} y1={yy} x2={size.width - size.right} y2={yy} stroke="currentColor" className="text-border" />
              <text x={size.left - 7} y={yy + 4} textAnchor="end" className="fill-muted-foreground text-xs">
                {valueFormatter(max * ratio)}
              </text>
            </g>
          );
        })}
        {data.map((row, i) => {
          const value = number(row[category]);
          const h = (value / max) * chartH;
          const xx = size.left + i * slot + (slot - barW) / 2;
          return (
            <rect key={i} x={xx} y={size.top + chartH - h} width={barW} height={h} rx="2" fill={color(colors[0])}>
              <title>{`${row[index]} · ${category}: ${valueFormatter(value)}`}</title>
            </rect>
          );
        })}
        {data.length > 0 && (
          <>
            <text x={size.left} y={size.height - 7} className="fill-muted-foreground text-xs">{String(data[0][index])}</text>
            <text x={size.width - size.right} y={size.height - 7} textAnchor="end" className="fill-muted-foreground text-xs">
              {String(data.at(-1)![index])}
            </text>
          </>
        )}
      </svg>
    </figure>
  );
}

function number(value: string | number | undefined) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function niceMax(value: number) {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / magnitude) * magnitude;
}

function color(name: string | undefined) {
  return PALETTE[name ?? "blue"] ?? name ?? PALETTE.blue;
}
