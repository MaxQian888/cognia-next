"use client"

/**
 * Marks a plugin whose permissions are being simulated in Managed IDE Dev
 * Mode (Plugin DevTools → Managed IDE). Shown wherever the plugin is, so a
 * decision that is not real is never mistaken for one.
 */

import { useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"
import { FlaskConicalIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { devModeVersion, isPluginSimulated, subscribeDevMode } from "@/lib/plugin/ide/dev-mode"

export function PluginSimulatedBadge({ pluginId }: { pluginId: string }) {
  const t = useTranslations("plugins.card")
  useSyncExternalStore(subscribeDevMode, devModeVersion, devModeVersion)
  if (!isPluginSimulated(pluginId)) return null
  return (
    <Badge
      variant="outline"
      className="gap-1 border-amber-500/50 text-xs text-amber-700 dark:text-amber-400"
      title={t("simulatedTitle")}
      data-testid={`plugin-simulated-badge-${pluginId}`}
    >
      <FlaskConicalIcon className="size-3" aria-hidden="true" />
      {t("simulated")}
    </Badge>
  )
}
