"use client"

// Settings → Appearance → Layout. Spacing and information-density controls
// that previously lived (mislabelled) under "Typography": global + per-surface
// density, and the two progressive-disclosure display modes (agent flow, usage
// statistics). Corner radius moved to the Style panel, where it reads as an
// override on the active style pack rather than a free-floating number
// (ADR-0148). Motion controls live in the Accessibility tab, which is their
// single canonical home.

import { useTranslations } from "next-intl"
import { Label } from "@/components/ui/label"
import { DensityCard } from "../components/density-card"
import { MessageDisplayCard } from "../components/message-display-card"
import { UsageDisplayCard } from "../components/usage-display-card"

export function LayoutTab() {
  const tLayout = useTranslations("settings.appearance.layoutType")

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <Label className="text-sm">{tLayout("density.sectionLabel")}</Label>
        <DensityCard />
      </section>

      <section className="space-y-2 border-t pt-4">
        <Label className="text-sm">{tLayout("messageDisplay.sectionLabel")}</Label>
        <MessageDisplayCard />
      </section>

      <section className="space-y-2 border-t pt-4">
        <Label className="text-sm">{tLayout("usageDisplay.sectionLabel")}</Label>
        <UsageDisplayCard />
      </section>
    </div>
  )
}
