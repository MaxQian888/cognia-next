"use client"

import React from "react"
import { useTranslations } from "next-intl"
import { Separator } from "@/components/ui/separator"

/**
 * ProviderAdvancedTab — legacy compound tab.
 *
 * Replaced inline by the split Routing / Health / Presets tabs inside
 * provider-settings.tsx. Keep this barrel-exported for any callers that
 * may still reference it, but render a lightweight placeholder pointing to
 * the individual tabs.
 */
export function ProviderAdvancedTab() {
  const t = useTranslations("providers")

  return (
    <div className="space-y-6">
      <section>
        <h3 className="mb-3 text-sm font-medium">{t("routing")}</h3>
        <p className="text-xs text-muted-foreground">
          Open the Advanced tab in the detail panel to view routing settings.
        </p>
      </section>
      <Separator />
      <section>
        <h3 className="mb-3 text-sm font-medium">{t("healthMonitoring")}</h3>
        <p className="text-xs text-muted-foreground">
          Open the Advanced tab in the detail panel to view health checks.
        </p>
      </section>
      <Separator />
      <section>
        <h3 className="mb-3 text-sm font-medium">{t("presets")}</h3>
        <p className="text-xs text-muted-foreground">
          Open the Advanced tab in the detail panel to view routing presets.
        </p>
      </section>
    </div>
  )
}
