"use client"

import React from "react"
import { useTranslations } from "next-intl"
import { Separator } from "@/components/ui/separator"
import { RoutingTab } from "./routing-tab"
import { HealthTab } from "./health-tab"
import { PresetsTab } from "./presets-tab"

export function ProviderAdvancedTab() {
  const t = useTranslations("providers")

  return (
    <div className="space-y-6">
      <section>
        <h3 className="mb-3 text-sm font-medium">{t("routing")}</h3>
        <RoutingTab />
      </section>
      <Separator />
      <section>
        <h3 className="mb-3 text-sm font-medium">{t("healthMonitoring")}</h3>
        <HealthTab />
      </section>
      <Separator />
      <section>
        <h3 className="mb-3 text-sm font-medium">{t("presets")}</h3>
        <PresetsTab />
      </section>
    </div>
  )
}
