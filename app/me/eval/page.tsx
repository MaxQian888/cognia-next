"use client"

/**
 * `/me/eval` — Agent evaluation defaults on the phone.
 *
 * The desktop `eval` settings section is pure `AppSettings.evalSettings`
 * persistence (judge model, default k / scorers, gate thresholds, cost guard)
 * with no Tauri dependency, so it embeds directly per ADR-0056 D3 rather than
 * getting a mobile rewrite. It was the only non-`desktopOnly` settings section
 * left without a `/me` entry.
 */

import { useTranslations } from "next-intl"

import { SubPageShell } from "@/components/mobile/me/sub-page-shell"
import { EvalSettingsSection } from "@/components/settings/eval/eval-settings-section"

export default function MobileEvalPage() {
  const t = useTranslations("mobile.me")
  return (
    <SubPageShell
      title={t("evalRow")}
      backAria={t("appearanceBackAria")}
      width="wide"
      testid="mobile-eval-page"
    >
      <EvalSettingsSection />
    </SubPageShell>
  )
}
