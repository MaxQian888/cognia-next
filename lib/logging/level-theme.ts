/**
 * LEVEL_THEME — single source of truth for per-LogLevel visual tokens.
 *
 * Replaces four duplicated tables that previously lived inside log-entry.tsx
 * (LEVEL_CONFIG), log-detail-panel.tsx (LEVEL_BADGE_COLORS),
 * log-stats-dashboard.tsx (LEVEL_COLORS) and log-timeline.tsx's bucket
 * classifier. Every class uses semantic theme tokens (success / warning /
 * destructive / chart-N / muted-foreground) defined in app/globals.css, so
 * dark-mode tracking is automatic and the wallpaper layer can bleed through
 * the `/10`–`/40` alpha tints.
 *
 * `chartColor` carries the bare CSS-variable name (no `var()` wrapper) so
 * useThemeColors can resolve it to the live oklch value for Recharts SVG
 * fill/stroke, which doesn't accept `var()` in presentation attributes.
 */

import { Bug, Info, AlertTriangle, AlertCircle, XCircle } from "lucide-react"
import type { LogLevel, LevelTheme } from "@/types/logging"

export type { LevelTheme, ThemeColorKey } from "@/types/logging"

export const LEVEL_THEME: Record<LogLevel, LevelTheme> = {
  trace: {
    icon: Bug,
    iconColor: "text-muted-foreground",
    badgeClass: "bg-muted text-muted-foreground",
    gutterClass: "border-l-muted-foreground/40",
    bgClass: "bg-muted/40",
    chartColor: "muted-foreground",
  },
  debug: {
    icon: Bug,
    iconColor: "text-chart-3",
    badgeClass: "bg-chart-3/15 text-chart-3",
    gutterClass: "border-l-chart-3/70",
    bgClass: "bg-chart-3/10",
    chartColor: "chart-3",
  },
  info: {
    icon: Info,
    iconColor: "text-success",
    badgeClass: "bg-success/15 text-success",
    gutterClass: "border-l-success/70",
    bgClass: "bg-success/10",
    chartColor: "success",
  },
  warn: {
    icon: AlertTriangle,
    iconColor: "text-warning",
    badgeClass: "bg-warning/15 text-warning",
    gutterClass: "border-l-warning/80",
    bgClass: "bg-warning/10",
    chartColor: "warning",
  },
  error: {
    icon: AlertCircle,
    iconColor: "text-destructive",
    badgeClass: "bg-destructive/15 text-destructive",
    gutterClass: "border-l-destructive/80",
    bgClass: "bg-destructive/10",
    chartColor: "destructive",
  },
  fatal: {
    icon: XCircle,
    iconColor: "text-destructive",
    badgeClass: "bg-destructive/25 text-destructive font-semibold",
    gutterClass: "border-l-destructive",
    bgClass: "bg-destructive/15",
    chartColor: "destructive",
  },
}

export const ALL_LEVELS: LogLevel[] = ["trace", "debug", "info", "warn", "error", "fatal"]
