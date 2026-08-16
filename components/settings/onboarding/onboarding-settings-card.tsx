"use client"

import { RotateCcwIcon } from "lucide-react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { CapabilityTour } from "@/components/onboarding/capability-tour"
import { ONBOARDING_ROUTE } from "@/lib/onboarding/route"
import { Separator } from "@/components/ui/separator"

/**
 * Settings → Discover entry points for the first-run flow (ADR-0122,
 * decisions 10 and 11).
 *
 * Two things that used to be unreachable after the fact now live here:
 *
 *  - **Run setup again.** The old dialog wrote a dismissal timestamp on any
 *    exit — including a stray Esc — and there was no way back. This is the
 *    re-entry the migration promises to everyone it marks `legacy_dismissed`;
 *    without it that decision would be "we silently decided for you".
 *  - **The capability tour.** It used to be the last three screens of setup,
 *    which meant every user was told about six subsystems before they had seen
 *    the product do anything. It is optional now, and this is where it lives.
 *
 * Discover is the right section: this is the "what else can this do" surface,
 * and the tour's six deep links all point into Settings anyway.
 */
export function OnboardingSettingsCard() {
  const t = useTranslations("onboarding")
  const router = useRouter()

  return (
    <div className="space-y-4" data-testid="settings-onboarding-card">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">{t("restart.label")}</h2>
        <p className="text-sm text-muted-foreground">{t("restart.description")}</p>
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={() => router.push(ONBOARDING_ROUTE)}
        data-testid="settings-onboarding-restart"
      >
        <RotateCcwIcon className="size-3.5" />
        {t("restart.label")}
      </Button>

      <Separator />

      <div className="space-y-1">
        <h2 className="text-lg font-semibold">{t("tour.title")}</h2>
        <p className="text-sm text-muted-foreground">{t("tour.description")}</p>
      </div>
      <CapabilityTour />
    </div>
  )
}
