"use client"

import { useTranslations } from "next-intl"

import { BrowserPreviewPane } from "@/components/browser/browser-preview-pane"
import { FeaturePageShell } from "@/components/feature-shell/feature-page-shell"

/** Desktop layout for the in-app browser preview route. */
export function BrowserDesktopBody() {
  const t = useTranslations("browser")
  return (
    <FeaturePageShell
      storageId="browser"
      toolbar={<h1 className="text-sm font-semibold">{t("title")}</h1>}
    >
      <BrowserPreviewPane />
    </FeaturePageShell>
  )
}
