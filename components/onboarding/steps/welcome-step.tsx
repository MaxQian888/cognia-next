"use client"

import { ArrowRightIcon, KeyRoundIcon, MonitorSmartphoneIcon } from "lucide-react"
import { useState } from "react"
import { useTranslations } from "next-intl"
import type { OnboardingShell } from "@cognia/agent-config-types"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Spinner } from "@/components/ui/spinner"
import type { MobileRuntimeMode } from "@/lib/runtime/standalone-mode"

interface WelcomeStepProps {
  shell: OnboardingShell
  /** Takes the recommended path — one screen, then the first task. */
  onStart: () => void
  /** Takes the step-by-step path — the four-step sequence, every choice open. */
  onCustomise: () => void
  /** Shown only when this device already has chats — see `OnboardingFlow`. */
  onSkipExisting?: () => void | Promise<void>
  /**
   * Mobile only. Commits the standalone/paired choice absorbed from the old
   * `/welcome` route. Does **not** advance — the path fork below does.
   */
  onPickMode?: (mode: MobileRuntimeMode) => void | Promise<void>
  /** Which mobile runtime mode is currently committed, if any. */
  mode?: MobileRuntimeMode
}

/**
 * Step 0 — the product intro, the path fork, and (on mobile) the runtime-mode
 * fork.
 *
 * ## The path fork is a primary and a link, not two cards
 *
 * "Recommended" and "custom" are not two equal options; one of them is what
 * almost everyone should press. Drawing them as matched cards would add a
 * decision to the screen whose entire job is to remove decisions — and on a
 * phone, where the runtime-mode fork already occupies two cards, a second pair
 * would put four cards above the fold. So: one large button, and a quiet line
 * beside it for the people who came here to configure something.
 *
 * ## Why the mode chooser lives here
 *
 * It used to be its own route, `app/(mobile-onboard)/welcome`, sitting outside
 * any flow. Folding it in is what lets one step sequence serve all four
 * shells: the choice it makes is precisely what decides whether this phone is
 * `mobile-standalone` or `mobile-paired`, and therefore which steps come next.
 * It commits the mode without advancing, so the phone makes both choices —
 * *how it runs*, then *how much it wants to be asked* — on one screen.
 *
 * It is not counted as progress in the stepper. Reading an intro is not setup,
 * and numbering it makes the flow feel longer than it is.
 */
export function WelcomeStep({
  shell,
  onStart,
  onCustomise,
  onSkipExisting,
  onPickMode,
  mode,
}: WelcomeStepProps) {
  const t = useTranslations("onboarding")
  const isMobile = shell === "mobile-standalone" || shell === "mobile-paired"
  const showModeFork = isMobile && !!onPickMode
  const [pending, setPending] = useState<string | null>(null)

  const run = async (key: string, fn: () => void | Promise<void>) => {
    if (pending) return
    setPending(key)
    try {
      await fn()
    } finally {
      setPending(null)
    }
  }

  return (
    <div className="flex flex-col gap-8" data-testid="onboarding-welcome">
      <div className="flex flex-col gap-4">
        <h1 className="text-balance text-4xl font-semibold leading-[1.05] tracking-tight sm:text-5xl">
          {t("welcome.headline")}
        </h1>
        <p className="max-w-[38ch] text-base leading-relaxed text-foreground">
          {t("welcome.lede")}
        </p>
      </div>

      {showModeFork && (
        <div className="flex flex-col gap-3">
          <h2 className="text-sm font-medium">{t("welcome.modeTitle")}</h2>
          <Card
            className={mode === "standalone" ? "border-brand-action/60 bg-brand-wash" : undefined}
            data-selected={mode === "standalone"}
          >
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <KeyRoundIcon className="size-4" aria-hidden />
                {t("welcome.byokTitle")}
              </CardTitle>
              <CardDescription>{t("welcome.byokDescription")}</CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                variant={mode === "standalone" ? "default" : "outline"}
                className="w-full"
                disabled={pending !== null}
                onClick={() => void run("standalone", () => onPickMode("standalone"))}
                data-testid="onboarding-mode-standalone"
              >
                {pending === "standalone" && <Spinner className="size-4" />}
                {t("welcome.byokCta")}
              </Button>
            </CardContent>
          </Card>
          <Card
            className={mode === "paired" ? "border-brand-action/60 bg-brand-wash" : undefined}
            data-selected={mode === "paired"}
          >
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <MonitorSmartphoneIcon className="size-4" aria-hidden />
                {t("welcome.pairTitle")}
              </CardTitle>
              <CardDescription>{t("welcome.pairDescription")}</CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                variant={mode === "paired" ? "default" : "outline"}
                className="w-full"
                disabled={pending !== null}
                onClick={() => void run("paired", () => onPickMode("paired"))}
                data-testid="onboarding-mode-paired"
              >
                {pending === "paired" && <Spinner className="size-4" />}
                {t("welcome.pairCta")}
              </Button>
            </CardContent>
          </Card>
        </div>
      )}

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <Button
            size="lg"
            // A phone must commit its runtime mode first: the mode is what
            // decides the sequence, so starting without one would build a plan
            // for a shell the user has not chosen.
            disabled={showModeFork && !mode}
            onClick={onStart}
            data-testid="onboarding-welcome-cta"
          >
            {t("welcome.cta")}
            <ArrowRightIcon className="size-4" />
          </Button>
          <Button
            variant="link"
            size="sm"
            className="h-auto p-0 text-muted-foreground"
            disabled={showModeFork && !mode}
            onClick={onCustomise}
            data-testid="onboarding-welcome-customise"
          >
            {t("welcome.customiseCta")}
          </Button>
        </div>
        <p className="max-w-[46ch] text-xs leading-relaxed text-muted-foreground">
          {t("welcome.sub")}
        </p>
        {onSkipExisting && (
          <Button
            variant="ghost"
            size="sm"
            className="self-start text-muted-foreground"
            disabled={pending !== null}
            onClick={() => void run("skip", onSkipExisting)}
            data-testid="onboarding-welcome-skip"
          >
            {pending === "skip" && <Spinner className="size-4" />}
            {t("welcome.skipExisting")}
          </Button>
        )}
      </div>
    </div>
  )
}
