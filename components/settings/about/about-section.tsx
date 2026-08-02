"use client"

import { useTranslations } from "next-intl"
import { InfoIcon } from "lucide-react"

import { Label } from "@/components/ui/label"

import { AboutHero } from "./about-hero"
import { LegalCreditsCard } from "./legal-credits-card"
import { ResourcesCard } from "./resources-card"
import { SystemDiagnosticsCard } from "./system-diagnostics-card"
import { UpdateCard } from "./update-card"
import { VersionBuildCard } from "./version-build-card"
import { WhatsNewCard } from "./whats-new-card"

/**
 * The About page — a branded hero followed by organized cards covering
 * version/build, system diagnostics, updates, what's new, resources, and
 * legal/credits. Shared by the desktop settings section
 * (`/settings?section=about`) and the mobile `/me/about` route; responsive
 * and platform-gated (Tauri / Capacitor / web) by each card.
 */
export function AboutSection() {
  const t = useTranslations("settings.about")

  return (
    <div className="space-y-6" data-testid="about-section">
      <div className="space-y-1">
        <Label className="flex items-center gap-2">
          <InfoIcon className="size-4" />
          {t("title")}
        </Label>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>

      <AboutHero />

      {/*
       * Bento rhythm: the dense identity/system pair sits side by side from xl
       * up, while the wide cards (updates, credits) span the full track so
       * their form rows and badge cloud keep room to breathe. Collapses to a
       * single column below xl — the mobile `/me/about` route always sees it.
       * Tracks stretch (no `items-start`) so paired cards share a baseline and
       * a bottom edge instead of ragging.
       */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <VersionBuildCard />
        <SystemDiagnosticsCard />
        <div className="xl:col-span-2">
          <UpdateCard />
        </div>
        <WhatsNewCard />
        <ResourcesCard />
        <div className="xl:col-span-2">
          <LegalCreditsCard />
        </div>
      </div>
    </div>
  )
}
