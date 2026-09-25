"use client"

import {
  ArrowRightIcon,
  KeyRoundIcon,
  RotateCcwIcon,
  SparklesIcon,
  type LucideIcon,
} from "lucide-react"
import { usePathname, useRouter } from "next/navigation"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { GuideCallout } from "@/components/guide/guide-callout"
import { ONBOARDING_ROUTE, onboardingHref } from "@/lib/onboarding/route"
import { shouldShowFinishBar } from "@/lib/onboarding/gate"
import { focusForGap, type SetupGap } from "@/lib/onboarding/setup-status"
import { isShellBypassRoute } from "@/lib/shell/bypass-routes"
import { useSetupStatus } from "@/hooks/onboarding/use-setup-status"
import { useSettingsStore } from "@/stores/settings/settings-store"

/**
 * i18n key segment per gap under `onboarding.finishBar.gap.*`. Shared with
 * the Settings status block so both surfaces say the same thing.
 */
export const SETUP_GAP_KEY: Record<SetupGap, "model" | "taskFailed" | "firstTask"> = {
  model: "model",
  "task-failed": "taskFailed",
  "first-task": "firstTask",
}

/** Icon per gap, shared with the Settings status block. */
export const SETUP_GAP_ICON: Record<SetupGap, LucideIcon> = {
  model: KeyRoundIcon,
  "task-failed": RotateCcwIcon,
  "first-task": SparklesIcon,
}

/**
 * The residual "finish setup" notice (ADR-0122 decision 13, ADR-0193).
 *
 * A skipped step should leave something behind, not vanish — so a user who
 * left setup early gets one thin, permanently-dismissable row naming the one
 * thing still missing, with a button that goes straight to it.
 *
 * **It names what is missing *now*.** The recorded exit path only says setup
 * was left unfinished; the gap itself is re-derived from live state
 * (`useSetupStatus`). Add a key in Settings → Providers and the "can't reach a
 * model" row is gone on the next render; the bar never again blames a missing
 * runtime on a machine that has one.
 *
 * **Self-hiding, and cheap when hidden.** Both shells mount it unconditionally
 * as a row of their own chrome (`DesktopAppShell` under the title bar,
 * `MobileShellWrapper` beside the offline banner). The settings read below is
 * all it costs on the normal path; the live probes only mount for a user who
 * actually left setup unfinished. It is deliberately NOT mounted at the body
 * level: the desktop shell is `h-screen` inside an `overflow:hidden` body, so a
 * bar laid out after it would be clipped.
 */
export function FinishSetupBar() {
  const pathname = usePathname()
  const settings = useSettingsStore((s) => s.settings)

  if (!settings || !shouldShowFinishBar(settings)) return null
  // Never render over the flow itself — the bar's whole purpose is to get the
  // user back there, and it would be pointing at the page it is sitting on.
  if (pathname?.startsWith(ONBOARDING_ROUTE)) return null
  // Chrome-free routes get no chrome. `/pair`, `/oauth` and the share target
  // are mid-task deep links owning the whole viewport — a "finish setup" CTA
  // there interrupts the task it is standing on and, on the mobile shell,
  // still paints because that wrapper only drops its tab bar.
  if (isShellBypassRoute(pathname)) return null

  return <FinishSetupRow />
}

function FinishSetupRow() {
  const t = useTranslations("onboarding.finishBar")
  const router = useRouter()
  const dismiss = useSettingsStore((s) => s.dismissOnboardingFinishBar)
  const { gaps } = useSetupStatus()

  const gap = gaps[0]
  // Everything the user skipped has since been put right somewhere else.
  if (!gap) return null
  const key = SETUP_GAP_KEY[gap]

  return (
    <GuideCallout
      variant="bar"
      tone={gap === "task-failed" ? "attention" : "brand"}
      icon={SETUP_GAP_ICON[gap]}
      title={t(`gap.${key}.title`)}
      description={t(`gap.${key}.description`)}
      testId="onboarding-finish-bar"
      actions={
        <Button
          size="sm"
          variant="outline"
          className="h-7 bg-background text-xs"
          onClick={() => router.push(onboardingHref(focusForGap(gap)))}
          data-testid="onboarding-finish-bar-cta"
          data-gap={gap}
        >
          {t(`gap.${key}.cta`)}
          <ArrowRightIcon className="size-3" />
        </Button>
      }
      dismiss={{
        onDismiss: () => void dismiss(),
        label: t("dismiss"),
        testId: "onboarding-finish-bar-dismiss",
      }}
    />
  )
}
