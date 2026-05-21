"use client"

import { useTranslations } from "next-intl"

import { SubPageShell } from "@/components/mobile/me/sub-page-shell"
import { OcrSectionPersisted } from "@/components/settings/ocr/ocr-section-persisted"

export default function MobileOcrPage() {
  const t = useTranslations("mobile.me")
  return (
    <SubPageShell title={t("ocrRow")} backAria={t("appearanceBackAria")} testid="mobile-ocr-page">
      <OcrSectionPersisted />
    </SubPageShell>
  )
}
