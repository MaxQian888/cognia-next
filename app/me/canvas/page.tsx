"use client"

import { useTranslations } from "next-intl"

import { SubPageShell } from "@/components/mobile/me/sub-page-shell"
import { CanvasSection } from "@/components/settings/canvas-section"

export default function MobileCanvasPage() {
  const t = useTranslations("mobile.me")
  return (
    <SubPageShell
      title={t("canvasRow")}
      backAria={t("appearanceBackAria")}
      width="wide"
      testid="mobile-canvas-page"
    >
      <CanvasSection />
    </SubPageShell>
  )
}
