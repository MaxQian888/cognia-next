"use client"

import { ArrowRightIcon, CircleCheckIcon, RotateCcwIcon } from "lucide-react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { CapabilityTour } from "@/components/onboarding/capability-tour"
import { SETUP_GAP_ICON, SETUP_GAP_KEY } from "@/components/onboarding/finish-setup-bar"
import { GuideCallout } from "@/components/guide/guide-callout"
import { Separator } from "@/components/ui/separator"
import { focusForGap } from "@/lib/onboarding/setup-status"
import { onboardingHref } from "@/lib/onboarding/route"
import { useSetupStatus } from "@/hooks/onboarding/use-setup-status"

/**
 * Settings → Discover entry points for the first-run flow (ADR-0122,
 * decisions 10 and 11; ADR-0193).
 *
 *  - **Setup status.** The same live answer the finish-setup bar reads, as a
 *    guide callout: what is still missing, with a button straight to it — or
 *    that nothing is. It ignores the bar's dismissal on purpose: closing the
 *    reminder is "stop nagging me", and this is where the user comes to ask.
 *  - **Run setup again.** The old dialog wrote a dismissal timestamp on any
 *    exit — including a stray Esc — and there was no way back. This is the
 *    re-entry the migration promises to everyone it marks `legacy_dismissed`.
 *  - **The capability tour.** It used to be the last three screens of setup,
 *    which meant every user was told about six subsystems before they had seen
 *    the product do anything. It is optional now, and this is where it lives.
 */
export function OnboardingSettingsCard() {
  const t = useTranslations("onboarding")
  const router = useRouter()
  const { gaps } = useSetupStatus()
  const gap = gaps[0]

  const restart = (
    <Button
      variant="outline"
      size="sm"
      className="bg-background"
      onClick={() => router.push(onboardingHref())}
      data-testid="settings-onboarding-restart"
    >
      <RotateCcwIcon className="size-3.5" />
      {t("restart.label")}
    </Button>
  )

  return (
    <div className="space-y-4" data-testid="settings-onboarding-card">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">{t("setupStatus.title")}</h2>
        <p className="text-sm text-muted-foreground">{t("setupStatus.description")}</p>
      </div>

      {gap ? (
        <GuideCallout
          tone={gap === "task-failed" ? "attention" : "brand"}
          icon={SETUP_GAP_ICON[gap]}
          title={t(`finishBar.gap.${SETUP_GAP_KEY[gap]}.title`)}
          description={t(`finishBar.gap.${SETUP_GAP_KEY[gap]}.description`)}
          testId="settings-onboarding-status"
          actions={
            <>
              <Button
                size="sm"
                onClick={() => router.push(onboardingHref(focusForGap(gap)))}
                data-testid="settings-onboarding-resume"
                data-gap={gap}
              >
                {t(`finishBar.gap.${SETUP_GAP_KEY[gap]}.cta`)}
                <ArrowRightIcon className="size-3.5" />
              </Button>
              {restart}
            </>
          }
        />
      ) : (
        <GuideCallout
          icon={CircleCheckIcon}
          title={t("setupStatus.complete.title")}
          description={t("setupStatus.complete.description")}
          testId="settings-onboarding-status"
          actions={restart}
        />
      )}

      <Separator />

      <div className="space-y-1">
        <h2 className="text-lg font-semibold">{t("tour.title")}</h2>
        <p className="text-sm text-muted-foreground">{t("tour.description")}</p>
      </div>
      <CapabilityTour />
    </div>
  )
}
