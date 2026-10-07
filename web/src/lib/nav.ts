import {
  Activity,
  BarChart3,
  BookOpen,
  Box,
  Boxes,
  FileText,
  LayoutDashboard,
  ListTree,
  Server,
  SquareTerminal,
  type LucideIcon,
} from "lucide-react";
import type { TranslationKey } from "@/i18n/en";
import { getSite } from "@/lib/site";

export interface NavItem {
  path: string;
  labelKey: TranslationKey;
  icon: LucideIcon;
  section: "monitor" | "raw" | "guide";
  /** shown only when the site turns this page on (GET /api/site `pages`) */
  page?: "slurm_guide" | "containers" | "getting_started";
}

export const NAV: NavItem[] = [
  { path: "/", labelKey: "nav.overview", icon: LayoutDashboard, section: "monitor" },
  { path: "/partitions", labelKey: "nav.partitions", icon: Boxes, section: "monitor" },
  { path: "/analytics", labelKey: "nav.analytics", icon: BarChart3, section: "monitor" },
  { path: "/login-nodes", labelKey: "nav.loginNodes", icon: Activity, section: "monitor" },
  { path: "/nodes", labelKey: "nav.nodes", icon: Server, section: "raw" },
  { path: "/jobs", labelKey: "nav.jobs", icon: ListTree, section: "raw" },
  { path: "/start", labelKey: "nav.start", icon: SquareTerminal, section: "guide", page: "getting_started" },
  { path: "/slurm", labelKey: "nav.slurm", icon: BookOpen, section: "guide", page: "slurm_guide" },
  { path: "/containers", labelKey: "nav.containers", icon: Box, section: "guide", page: "containers" },
  { path: "/project", labelKey: "nav.project", icon: FileText, section: "guide" },
];

/** The sidebar's pages: site-specific ones only where the site enables them. */
export const visibleNav = () => NAV.filter((item) => !item.page || getSite().pages[item.page]);

/** Pages where the global resource-type filter applies. Raw tables have their own local filters. */
export const FILTERED_PATHS = new Set(["/", "/partitions"]);
