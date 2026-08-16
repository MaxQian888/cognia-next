"use client"

import { ArrowRightIcon, KeyRoundIcon, Loader2Icon, MonitorSmartphoneIcon } from "lucide-react"
import { useState } from "react"
import { useTranslations } from "next-intl"
import type { OnboardingShell } from "@cognia/agent-config-types"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import type { MobileRuntimeMode } from "@/lib/runtime/standalone-mode"

interface WelcomeStepProps {
  shell: OnboardingShell
  onNext: () => void
  /** Shown only when this device already has chats — see `OnboardingFlow`. */
  onSkipExisting?: () => void | Promise<void>
  /**
   * Mobile only. Commits the standalone/paired choice absorbed from the old
   * `/welcome` route, then advances.
   */
  onPickMode?: (mode: MobileRuntimeMode) => void | Promise<void>
}

/**
 * Step 0 — the product intro, plus (on mobile) the runtime-mode fork.
 *
 * **Why the mode chooser lives here.** It used to be its own route,
 * `app/(mobile-onboard)/welcome`, sitting outside any flow. Folding it in is
 * what lets one step sequence serve all four shells: the choice it makes is
 * precisely what decides whether this phone is `mobile-standalone` or
 * `mobile-paired`, and therefore which steps come next.
 *
 * It is not counted as progress in the rail. Reading an intro is not setup, and
 * numbering it makes the flow feel longer than it is.
 */
export function WelcomeStep({ shell, onNext, onSkipExisting, onPickMode }: WelcomeStepProps) {
  const t = useTranslations("onboarding")
  const isMobile = shell === "mobile-standalone" || shell === "mobile-paired"
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
        <h1 className="text-balance text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
          {t("welcome.headline")}
        </h1>
        <p className="text-base leading-relaxed text-foreground">{t("welcome.lede")}</p>
        <p className="text-sm leading-relaxed text-muted-foreground">{t("welcome.sub")}</p>
      </div>

      {isMobile && onPickMode ? (
        <div className="flex flex-col gap-3">
          <h2 className="text-sm font-medium">{t("welcome.modeTitle")}</h2>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <KeyRoundIcon className="size-4" aria-hidden />
                {t("welcome.byokTitle")}
              </CardTitle>
              <CardDescription>{t("welcome.byokDescription")}</CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                className="w-full"
                disabled={pending !== null}
                onClick={() => void run("standalone", () => onPickMode("standalone"))}
                data-testid="onboarding-mode-standalone"
              >
                {pending === "standalone" && <Loader2Icon className="size-4 animate-spin" />}
                {t("welcome.byokCta")}
              </Button>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <MonitorSmartphoneIcon className="size-4" aria-hidden />
                {t("welcome.pairTitle")}
              </CardTitle>
              <CardDescription>{t("welcome.pairDescription")}</CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                variant="outline"
                className="w-full"
                disabled={pending !== null}
                onClick={() => void run("paired", () => onPickMode("paired"))}
                data-testid="onboarding-mode-paired"
              >
                {pending === "paired" && <Loader2Icon className="size-4 animate-spin" />}
                {t("welcome.pairCta")}
              </Button>
            </CardContent>
          </Card>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <Button size="lg" onClick={onNext} data-testid="onboarding-welcome-cta">
            {t("welcome.cta")}
            <ArrowRightIcon className="size-4" />
          </Button>
          {onSkipExisting && (
            <Button
              size="lg"
              variant="ghost"
              disabled={pending !== null}
              onClick={() => void run("skip", onSkipExisting)}
              data-testid="onboarding-welcome-skip"
            >
              {pending === "skip" && <Loader2Icon className="size-4 animate-spin" />}
              {t("welcome.skipExisting")}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
