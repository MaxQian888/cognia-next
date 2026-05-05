"use client"

// Banner that signals the marketplace's current source mode. Reads directly
// from `usePluginMarketplaceStore.sourceState.mode` so the UI reflects the
// runtime fallback decisions made by the marketplace client (network
// failures → degraded; explicit demo flag → demo).
//
// Renders nothing for the "remote" mode — the happy path stays visually
// quiet so the banner's presence carries information.

import { useTranslations } from "next-intl"
import { AlertTriangleIcon, FlaskConicalIcon } from "lucide-react"
import { Card } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import { usePluginMarketplaceStore } from "@/stores/plugin/plugin-marketplace-store"
import type { MarketplaceSourceMode } from "@/stores/plugin/plugin-marketplace-store"

interface Props {
  /** Override the mode for tests / preview surfaces. */
  mode?: MarketplaceSourceMode
  className?: string
}

export function PluginMarketplaceModeBanner({ mode: override, className }: Props) {
  const t = useTranslations("plugins.marketplace.modeBanner")
  const storeMode = usePluginMarketplaceStore((s) => s.sourceState.mode)
  const mode = override ?? storeMode

  if (mode === "remote") return null

  if (mode === "demo") {
    return (
      <Card
        role="status"
        className={cn("p-3 flex items-start gap-2 border-blue-500/40 bg-blue-500/5", className)}
        data-testid="plugin-marketplace-mode-banner-demo"
      >
        <FlaskConicalIcon
          className="size-4 mt-0.5 shrink-0 text-blue-700 dark:text-blue-300"
          aria-hidden
        />
        <div className="space-y-0.5 min-w-0">
          <p className="text-sm font-medium text-blue-900 dark:text-blue-100">{t("demoTitle")}</p>
          <p className="text-xs text-blue-800/80 dark:text-blue-200/80">{t("demoHint")}</p>
        </div>
      </Card>
    )
  }

  return (
    <Card
      role="status"
      className={cn("p-3 flex items-start gap-2 border-amber-500/40 bg-amber-500/5", className)}
      data-testid="plugin-marketplace-mode-banner-degraded"
    >
      <AlertTriangleIcon
        className="size-4 mt-0.5 shrink-0 text-amber-700 dark:text-amber-300"
        aria-hidden
      />
      <div className="space-y-0.5 min-w-0">
        <p className="text-sm font-medium text-amber-900 dark:text-amber-100">
          {t("degradedTitle")}
        </p>
        <p className="text-xs text-amber-800/80 dark:text-amber-200/80">{t("degradedHint")}</p>
      </div>
    </Card>
  )
}
