import type { CSSProperties } from "react"

// The Recharts tooltip renders as an HTML <div>, so CSS custom properties
// resolve directly — but the theme tokens are oklch, and wrapping them as
// `hsl(var(--popover))` yields `hsl(oklch(…))`, which is invalid CSS and gets
// dropped (the tooltip then falls back to an unthemed white box). Reference
// the vars directly instead. (SVG presentation attributes like grid/axis
// strokes still can't resolve `var()` — those resolve via `useThemeColors`.)
export const TOOLTIP_STYLE = {
  contentStyle: {
    backgroundColor: "var(--popover)",
    border: "1px solid var(--border)",
    borderRadius: "6px",
    color: "var(--popover-foreground)",
  } as CSSProperties,
  labelStyle: {
    fontWeight: "bold",
  } as CSSProperties,
  itemStyle: {
    color: "var(--popover-foreground)",
  } as CSSProperties,
}

export const CHART_MARGINS = {
  default: { top: 10, right: 30, left: 0, bottom: 0 },
  withYAxis: { top: 10, right: 30, left: 20, bottom: 0 },
  compact: { top: 5, right: 10, left: 5, bottom: 5 },
  vertical: { top: 5, right: 30, left: 20, bottom: 5 },
}

export const CHART_COLORS = {
  primary: "#8884d8",
  secondary: "#82ca9d",
  tertiary: "#ffc658",
  quaternary: "#ff7300",
  success: "#22c55e",
  warning: "#eab308",
  error: "#ef4444",
  info: "#3b82f6",
}

export const EXTENDED_COLORS = [
  "#8884d8",
  "#82ca9d",
  "#ffc658",
  "#ff7300",
  "#00C49F",
  "#FFBB28",
  "#FF8042",
  "#0088FE",
  "#a855f7",
  "#ec4899",
]

export const PERCENTILE_COLORS = {
  p50: "#22c55e",
  p90: "#eab308",
  p99: "#ef4444",
}

export const TOKEN_COLORS = {
  input: "#8884d8",
  output: "#82ca9d",
}

export const GRID_STYLE = {
  strokeDasharray: "3 3",
  stroke: "hsl(var(--border))",
  strokeOpacity: 0.5,
}

export const AXIS_STYLE = {
  tick: {
    fill: "hsl(var(--muted-foreground))",
    fontSize: 12,
  },
  axisLine: {
    stroke: "hsl(var(--border))",
  },
}
