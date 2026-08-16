"use client"

/**
 * Settings → Discover section. Hosts the shared `<DiscoverCustomizer/>` inline
 * so the discover category layout can be edited from
 * `/settings?section=discover` as well as from the discover sidebar's own
 * "Customize" dialog. Mirrors `components/settings/sidebar/shell-layout-section.tsx`.
 */

import * as React from "react"
import { useTranslations } from "next-intl"

import { DiscoverCustomizer } from "@/components/discover/discover-customizer"
import { DiscoverPreferences } from "@/components/settings/discover/discover-preferences"
import { OnboardingSettingsCard } from "@/components/settings/onboarding/onboarding-settings-card"
import { Separator } from "@/components/ui/separator"

export function DiscoverSection(): React.ReactElement {
  const t = useTranslations("discover")
  return (
    <div className="space-y-6" data-testid="settings-discover-section">
      <DiscoverPreferences />
      <Separator />
      <div className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">{t("customize.title")}</h2>
          <p className="text-sm text-muted-foreground">{t("customize.description")}</p>
        </div>
        <DiscoverCustomizer />
      </div>
      <Separator />
      {/* First-run re-entry + the capability tour (ADR-0122). Discover is the
       * "what else can this do" surface, and the tour's own deep links all
       * point back into Settings. */}
      <OnboardingSettingsCard />
    </div>
  )
}
