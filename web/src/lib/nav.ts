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
  type LucideIcon,
} from "lucide-react";
import type { TranslationKey } from "@/i18n/en";

export interface NavItem {
  path: string;
  labelKey: TranslationKey;
  descKey: TranslationKey;
  icon: LucideIcon;
  section: "monitor" | "raw" | "guide";
}

export const NAV: NavItem[] = [
  { path: "/", labelKey: "nav.overview", descKey: "page.overview.desc", icon: LayoutDashboard, section: "monitor" },
  { path: "/partitions", labelKey: "nav.partitions", descKey: "page.partitions.desc", icon: Boxes, section: "monitor" },
  { path: "/analytics", labelKey: "nav.analytics", descKey: "page.analytics.desc", icon: BarChart3, section: "monitor" },
  { path: "/login-nodes", labelKey: "nav.loginNodes", descKey: "page.loginNodes.desc", icon: Activity, section: "monitor" },
  { path: "/nodes", labelKey: "nav.nodes", descKey: "page.nodes.desc", icon: Server, section: "raw" },
  { path: "/jobs", labelKey: "nav.jobs", descKey: "page.jobs.desc", icon: ListTree, section: "raw" },
  { path: "/slurm", labelKey: "nav.slurm", descKey: "page.slurm.desc", icon: BookOpen, section: "guide" },
  { path: "/containers", labelKey: "nav.containers", descKey: "page.containers.desc", icon: Box, section: "guide" },
  { path: "/project", labelKey: "nav.project", descKey: "page.project.desc", icon: FileText, section: "guide" },
];

/** Pages where the global resource-type filter applies. Raw tables have their own local filters. */
export const FILTERED_PATHS = new Set(["/", "/partitions"]);
