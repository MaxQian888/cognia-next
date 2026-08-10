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
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
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
      <Alert
        role="status"
        className={cn("border-primary/40 bg-primary/5", className)}
        data-testid="plugin-marketplace-mode-banner-demo"
      >
        <FlaskConicalIcon className="text-primary" aria-hidden />
        <AlertTitle>{t("demoTitle")}</AlertTitle>
        <AlertDescription className="text-xs">{t("demoHint")}</AlertDescription>
      </Alert>
    )
  }

  return (
    <Alert
      role="status"
      variant="destructive"
      className={cn("border-destructive/40 bg-destructive/5", className)}
      data-testid="plugin-marketplace-mode-banner-degraded"
    >
      <AlertTriangleIcon aria-hidden />
      <AlertTitle>{t("degradedTitle")}</AlertTitle>
      <AlertDescription className="text-xs">{t("degradedHint")}</AlertDescription>
    </Alert>
  )
}
