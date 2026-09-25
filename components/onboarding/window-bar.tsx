"use client"

import { useTranslations } from "next-intl"

import { GuideWindowBar } from "@/components/guide/guide-window-bar"

interface OnboardingWindowBarProps {
  /** Step back. Omitted on the first step, which has nowhere to go. */
  onBack?: () => void
  /** Steps raise this while a request is in flight. */
  busy?: boolean
}

/**
 * The first-run takeover's top row: the shared guide window bar with the
 * onboarding copy and test ids (ADR-0122, ADR-0193).
 *
 * `/onboarding` suppresses the desktop chrome (`isOnboardingRoute` in
 * `DesktopAppShell`), and the app is a frameless Tauri window — so this row is
 * the flow's only drag region and close button. Back lives here, at every
 * width, rather than once per breakpoint.
 */
export function OnboardingWindowBar({ onBack, busy = false }: OnboardingWindowBarProps) {
  const t = useTranslations("onboarding")
  return (
    <GuideWindowBar
      wordmark={t("wordmark")}
      back={onBack ? { onBack, label: t("back") } : undefined}
      busy={busy}
      testIdPrefix="onboarding"
    />
  )
}
