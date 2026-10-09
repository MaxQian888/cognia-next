// The console's "Insights" tab: the Attention Radar report and, below it, the
// capture settings that feed it.
//
// The capture block used to sit straight under the radar with nothing saying
// why a pet console holds a content-capture form. It gets a headed section of
// its own that names the relationship (captures are part of what the radar
// reads), separated from the report by a hairline instead of a card.

"use client"

import { useTranslations } from "next-intl"
import { Separator } from "@/components/ui/separator"
import { CaptureSettingsPanel } from "@/components/capture/capture-settings-panel"
import { RadarPanel } from "./radar-panel"

export function InsightsTab() {
  const t = useTranslations("pet")
  return (
    <div data-testid="pet-insights-tab" className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <RadarPanel />
      <Separator />
      <section aria-labelledby="pet-insights-capture-heading" className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 id="pet-insights-capture-heading" className="text-base font-semibold">
            {t("console.insights.captureTitle")}
          </h2>
          <p className="text-sm text-pretty text-muted-foreground">
            {t("console.insights.captureDescription")}
          </p>
        </div>
        <CaptureSettingsPanel />
      </section>
    </div>
  )
}
