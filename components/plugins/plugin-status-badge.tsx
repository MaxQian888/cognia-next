"use client"

// Status & runtime-warning badges for an installed plugin row.
//
// Two pieces:
//   • `PluginStatusPill` — single chip describing enabled / disabled /
//     loading / error. Shared by `plugin-card.tsx` and the settings
//     `InstalledTab` so the same status text doesn't drift between callers.
//   • `PluginRuntimeWarnings` — amber chip per warning the loader stamped
//     into `manifest._cogniaWarnings` (e.g. "python-runtime-unavailable" when
//     the Tauri Python runtime isn't available in web mode).
//
// Both are pure presentational and i18n-driven so consumers can drop them
// into any container.

import { useTranslations } from "next-intl"
import { AlertTriangleIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { PluginRow } from "@/lib/db/plugin-types"

export interface PluginStatusPillProps {
  status: string
  enabled: boolean
  /** Set when the manager is mid-transition (loading / enabling / updating). */
  loading?: boolean
  className?: string
}

export function PluginStatusPill({ status, enabled, loading, className }: PluginStatusPillProps) {
  const t = useTranslations("plugins.card.status")
  if (status === "error") {
    return (
      <Badge variant="destructive" className={cn("text-xs", className)}>
        {t("error")}
      </Badge>
    )
  }
  if (loading) {
    return (
      <Badge variant="outline" className={cn("text-xs", className)}>
        {t("loading")}
      </Badge>
    )
  }
  if (status === "suspended") {
    return (
      <Badge variant="outline" className={cn("text-xs", className)}>
        {t("suspended")}
      </Badge>
    )
  }
  if (!enabled) {
    return (
      <Badge variant="outline" className={cn("text-xs", className)}>
        {t("disabled")}
      </Badge>
    )
  }
  return (
    <Badge variant="secondary" className={cn("text-xs", className)}>
      {t("enabled")}
    </Badge>
  )
}

/**
 * Read the runtime-warning markers the plugin loader stamped onto a row's
 * manifest. Returns an empty array when the field is absent or malformed.
 */
export function readPluginRuntimeWarnings(plugin: Pick<PluginRow, "manifest">): string[] {
  const raw = (plugin.manifest as { _cogniaWarnings?: unknown })._cogniaWarnings
  if (!Array.isArray(raw)) return []
  return raw.filter((entry): entry is string => typeof entry === "string")
}

export interface PluginRuntimeWarningsProps {
  plugin: Pick<PluginRow, "manifest">
  className?: string
}

export function PluginRuntimeWarnings({ plugin, className }: PluginRuntimeWarningsProps) {
  const t = useTranslations("plugins.card.runtimeWarnings")
  const warnings = readPluginRuntimeWarnings(plugin)
  if (warnings.length === 0) return null
  return (
    <div className={cn("flex flex-wrap items-center gap-1", className)}>
      {warnings.map((code) => (
        <Badge
          key={code}
          variant="outline"
          className="border-amber-500/40 text-amber-700 dark:text-amber-300 text-xs gap-1"
          data-testid={`plugin-runtime-warning-${code}`}
        >
          <AlertTriangleIcon className="size-3 shrink-0" />
          <span className="truncate">{t(code as never)}</span>
        </Badge>
      ))}
    </div>
  )
}
