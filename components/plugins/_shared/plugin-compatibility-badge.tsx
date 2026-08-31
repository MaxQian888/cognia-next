"use client"

/**
 * "Can this plugin run on this device, and if not, why."
 *
 * The answer already existed and nothing showed it. `PluginManager` calls
 * `collectPluginRuntimeProfileDiagnostics` on every manifest, stores the result
 * on `Plugin.compatibilityDiagnostics`, and uses an error-severity diagnostic
 * to exclude the plugin from automatic activation. The manager's own comment
 * says such a plugin "stays discovered and visible in /plugins (flagged
 * incompatible)". No component ever read that field, and there was no
 * `incompatible` string in either locale's plugin messages, so on the web and
 * mobile shells the flag was computed, enforced, and invisible.
 *
 * This calls the same pure function rather than reading the stored field, so it
 * also works for a marketplace entry that is not installed yet and for a row
 * the manager has not touched.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { CircleSlashIcon, TriangleAlertIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
// Imported from its own module rather than the hooks barrel: a leaf badge
// should not drag the whole barrel in, and every suite that mocks
// `@/hooks/plugins` for its own reasons would otherwise have to learn
// about this hook too.
import { usePluginRuntimeProfile } from "@/hooks/plugins/use-plugin-runtime-profile"
import { collectPluginRuntimeProfileDiagnostics } from "@/lib/plugin/core/runtime-compatibility"
import { cn } from "@/lib/utils"
import type { PluginManifest } from "@/types/plugin"

export interface PluginCompatibilityBadgeProps {
  manifest: PluginManifest | Record<string, unknown> | undefined
  className?: string
  /**
   * Applied to the label text only, so a dense caller can collapse the badge
   * to its icon at narrow widths and let the tooltip carry the words. The
   * class is the caller's, because only the caller knows which container
   * query it sits in.
   */
  labelClassName?: string
}

export function PluginCompatibilityBadge({
  manifest,
  className,
  labelClassName,
}: PluginCompatibilityBadgeProps) {
  const t = useTranslations("plugins.compatibility")
  const profile = usePluginRuntimeProfile()

  // `tauri` short-circuits inside the collector, so the desktop render is
  // unchanged and costs one function call that returns an empty array.
  const worst = useMemo(() => {
    if (!manifest) return null
    const diagnostics = collectPluginRuntimeProfileDiagnostics(manifest as PluginManifest, profile)
    return (
      diagnostics.find((d) => d.severity === "error") ??
      diagnostics.find((d) => d.severity === "warning") ??
      null
    )
  }, [manifest, profile])

  if (!worst) return null

  const blocked = worst.severity === "error"
  const host = t(`host.${profile}` as never)
  const Icon = blocked ? CircleSlashIcon : TriangleAlertIcon

  return (
    // Self-contained provider, like `ExplainedBadge` in the marketplace card:
    // the app mounts one in `app/layout.tsx`, but this badge is rendered by
    // stories and unit tests that have no layout above them.
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            // Outline rather than a solid destructive block: on a browser
            // build this appears on most rows (a plugin that declares no
            // browser compatibility genuinely is not started here), and a wall
            // of red reads as breakage rather than as the fact it states. The
            // row already carries a status pill for the plugin's own health.
            variant="outline"
            className={cn(
              "shrink-0 gap-1 text-xs",
              blocked
                ? "border-destructive/40 text-destructive"
                : "border-amber-500/40 text-amber-700 dark:text-amber-300",
              className
            )}
            data-testid="plugin-compatibility-badge"
            data-severity={worst.severity}
          >
            <Icon className="size-3 shrink-0" />
            <span className={labelClassName}>
              {blocked ? t("blockedLabel") : t("degradedLabel")}
            </span>
          </Badge>
        </TooltipTrigger>
        <TooltipContent>
          <div className="max-w-64 space-y-1 text-xs">
            <p>{blocked ? t("blockedTooltip", { host }) : t("degradedTooltip", { host })}</p>
            {/*
            The diagnostic's own message and hint come from the manifest author
            (`runtimeCompatibility.<profile>.reason`) or from the collector, and
            are the only part that can name THIS plugin's actual limitation.
          */}
            <p className="text-muted-foreground">{worst.message}</p>
            {worst.hint ? <p className="text-muted-foreground">{worst.hint}</p> : null}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
