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
import { usePluginMarketplaceStore } from "@/stores/plugin-runtime/plugin-marketplace-store"
import type { MarketplaceSourceMode } from "@/stores/plugin-runtime/plugin-marketplace-store"

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

  // Colour bands use semantic tokens with opacity layering so dark mode
  // inherits the theme automatically — the previous hardcoded
  // `dark:text-blue-300` overrides left the banner drifting from the rest
  // of the marketplace surface when the user retuned their primary hue.
  if (mode === "demo") {
    return (
      <Card
        role="status"
        className={cn("p-3 flex items-start gap-2 border-primary/40 bg-primary/5", className)}
        data-testid="plugin-marketplace-mode-banner-demo"
      >
        <FlaskConicalIcon className="size-4 mt-0.5 shrink-0 text-primary" aria-hidden />
        <div className="space-y-0.5 min-w-0">
          <p className="text-sm font-medium text-foreground">{t("demoTitle")}</p>
          <p className="text-xs text-muted-foreground">{t("demoHint")}</p>
        </div>
      </Card>
    )
  }

  return (
    <Card
      role="status"
      className={cn("p-3 flex items-start gap-2 border-destructive/40 bg-destructive/5", className)}
      data-testid="plugin-marketplace-mode-banner-degraded"
    >
      <AlertTriangleIcon className="size-4 mt-0.5 shrink-0 text-destructive" aria-hidden />
      <div className="space-y-0.5 min-w-0">
        <p className="text-sm font-medium text-foreground">{t("degradedTitle")}</p>
        <p className="text-xs text-muted-foreground">{t("degradedHint")}</p>
      </div>
    </Card>
  )
}
