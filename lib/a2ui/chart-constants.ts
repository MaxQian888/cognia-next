/**
 * A2UI Chart Constants
 * Shared constants for the Chart component
 */

/**
 * Default color palette for chart series
 */
export const DEFAULT_CHART_COLORS = ["#8884d8", "#82ca9d", "#ffc658", "#ff7300", "#00C49F"]

/**
 * Tooltip style matching the app's design system.
 *
 * The theme tokens are oklch, so they are referenced bare: wrapping them as
 * `hsl(var(--popover))` produced `hsl(oklch(…))`, which is invalid CSS and was
 * dropped, leaving an unthemed, borderless tooltip. Recharts renders the
 * tooltip as an HTML `<div>`, where `var()` resolves normally.
 */
export const CHART_TOOLTIP_STYLE = {
  backgroundColor: "var(--popover)",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  color: "var(--popover-foreground)",
}
