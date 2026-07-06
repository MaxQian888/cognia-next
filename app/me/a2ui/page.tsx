"use client"

import { useTranslations } from "next-intl"

import { SubPageShell } from "@/components/mobile/me/sub-page-shell"
import { A2UISection } from "@/components/settings/a2ui-section"

export default function MobileA2uiPage() {
  const t = useTranslations("mobile.me")
  // `A2UISection` reads `?a2uiTab=` via `useSearchParams`; `SubPageShell`
  // already wraps children in a `Suspense` boundary, which that hook requires.
  return (
    <SubPageShell
      title={t("a2uiRow")}
      backAria={t("appearanceBackAria")}
      width="wide"
      testid="mobile-a2ui-page"
    >
      <A2UISection />
    </SubPageShell>
  )
}
