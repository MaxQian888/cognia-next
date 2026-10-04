"use client"

/**
 * A period-over-period change chip: "▲ 23%" under a headline figure.
 *
 * The direction is not the verdict. More spend is usually worth a second look,
 * a higher cache-hit rate is good, and more turns is neither, so the caller
 * says which way is "good" and the chip colours accordingly. A change the data
 * cannot support (`null`) renders a muted dash with an explanation rather than
 * disappearing, so a row of tiles keeps one height and the missing comparison
 * is visible as missing.
 */

import { useTranslations } from "next-intl"
import { ArrowDownRightIcon, ArrowRightIcon, ArrowUpRightIcon } from "lucide-react"

import { cn } from "@/lib/utils"

/** Which direction counts as an improvement for this figure. */
export type UsageDeltaPolarity = "lower-is-better" | "higher-is-better" | "neutral"

export interface UsageDeltaProps {
  /** Relative change (0.25 = +25%) or, with `unit="points"`, percentage points. */
  change: number | null
  unit?: "relative" | "points"
  polarity?: UsageDeltaPolarity
  className?: string
  testid?: string
}

/** Below this the change is shown as flat: ±0.5% is rounding noise, not a trend. */
const FLAT_EPSILON = 0.005

function formatValue(change: number, unit: "relative" | "points"): string {
  const abs = Math.abs(change)
  if (unit === "points") return abs >= 10 ? String(Math.round(abs)) : abs.toFixed(1)
  const pct = abs * 100
  return `${pct >= 10 ? Math.round(pct) : pct.toFixed(1)}%`
}

export function UsageDelta({
  change,
  unit = "relative",
  polarity = "neutral",
  className,
  testid,
}: UsageDeltaProps) {
  const t = useTranslations("usageInsights.delta")

  if (change == null || !Number.isFinite(change)) {
    return (
      <span
        className={cn("text-[10px] text-muted-foreground", className)}
        title={t("noBaseline")}
        aria-label={t("noBaseline")}
        data-testid={testid}
        data-direction="none"
      >
        —
      </span>
    )
  }

  const flat = Math.abs(unit === "points" ? change / 100 : change) < FLAT_EPSILON
  const direction = flat ? "flat" : change > 0 ? "up" : "down"
  const good =
    polarity === "neutral" || flat
      ? null
      : (direction === "up") === (polarity === "higher-is-better")
  const raw = formatValue(change, unit)
  const value = unit === "points" ? t("points", { value: raw }) : raw
  const label = direction === "flat" ? t("flat") : t(direction, { value })
  const Icon =
    direction === "up"
      ? ArrowUpRightIcon
      : direction === "down"
        ? ArrowDownRightIcon
        : ArrowRightIcon

  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 text-[10px] font-medium tabular-nums",
        good === null && "text-muted-foreground",
        good === true && "text-emerald-600 dark:text-emerald-400",
        good === false && "text-amber-600 dark:text-amber-400",
        className
      )}
      title={label}
      aria-label={label}
      data-testid={testid}
      data-direction={direction}
    >
      <Icon className="size-3" aria-hidden />
      {direction === "flat" ? "0%" : `${direction === "up" ? "+" : "−"}${value}`}
    </span>
  )
}
