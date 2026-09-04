"use client"

/**
 * Determinate activation progress strip (ADR-0096).
 *
 * ADR-0096 shipped with an explicit gap in its Consequences: "Determinate
 * progress is still missing for plugin activation (10–45s)". This closes it.
 *
 * Accessibility is delegated entirely to `LoadingRegion`, which owns
 * `aria-busy` and the single polite status message for the area. This component
 * only decides what text goes in and how tall the bar is — it never adds a
 * second live region, and it never passes `onCancel`, because `enablePlugin`
 * has no cancellation token and ADR-0096 says to offer cancel only when it
 * genuinely stops the work.
 */

import { useTranslations } from "next-intl"

import { LoadingRegion } from "@/components/ui/loading-region"
import { usePluginActivationProgress } from "@/hooks/plugins/use-plugin-activation-progress"
import { cn } from "@/lib/utils"

export interface PluginActivationProgressProps {
  pluginId: string
  /** Display name for the announcement. Falls back to the id. */
  pluginName?: string
  /**
   * `row` keeps the phase text sr-only and uses a hairline bar so a dense list
   * does not reflow; `card` and `detail` show the phase and the count.
   */
  variant?: "row" | "card" | "detail"
  className?: string
}

export function PluginActivationProgress({
  pluginId,
  pluginName,
  variant = "row",
  className,
}: PluginActivationProgressProps) {
  const t = useTranslations("plugins.activation")
  const { progress, active, phaseLabel, countLabel } = usePluginActivationProgress(pluginId)

  // Nothing to say when no activation is in flight. Terminal entries linger
  // briefly in the store for the toast to read, but the bar is for work in
  // progress, so it stops rendering the moment the run ends.
  if (!progress || !active) return null

  const name = pluginName ?? pluginId
  const label = t("label", { name })
  const showText = variant !== "row"

  return (
    <div
      data-slot="plugin-activation-progress"
      data-variant={variant}
      className={cn("w-full", variant === "row" ? "mt-1" : "mt-2", className)}
    >
      <LoadingRegion
        loading
        loadingKey={pluginId}
        label={label}
        progress={{
          processed: progress.processed,
          total: progress.total,
          phaseLabel,
        }}
        // A list row is one line tall. The region's own detail line is taller
        // than that, so in `row` it either shoved the row's badges around or
        // printed over them. The bar alone is the whole indicator there, and
        // the polite announcement still carries the phase and the count.
        showDetail={showText}
        // The bar IS the indicator, so there is no separate skeleton to swap in.
        fallback={null}
        className={cn(
          // The shared region draws a 4px solid-primary bar, which at the edge
          // of a dense list row reads as a heavy black rule rather than as
          // progress, and is easily mistaken for the row divider it sits on.
          // Halve it and tint it in `row` only.
          variant === "row" &&
            "[&_[data-slot=progress]]:h-0.5 [&_[data-slot=progress]]:bg-primary/15 [&_[data-slot=progress-indicator]]:bg-primary/60"
        )}
      />
      {showText ? (
        // aria-hidden: LoadingRegion's status element already announced both.
        <div
          aria-hidden="true"
          className="mt-1 flex items-center justify-between gap-2 text-xs text-muted-foreground"
        >
          <span className="truncate">{phaseLabel}</span>
          <span className="shrink-0 tabular-nums">{countLabel}</span>
        </div>
      ) : null}
    </div>
  )
}

export default PluginActivationProgress
