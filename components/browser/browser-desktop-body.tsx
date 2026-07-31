"use client"

import { useTranslations } from "next-intl"
import { GlobeIcon } from "lucide-react"

import { BrowserPreviewPane } from "@/components/browser/browser-preview-pane"
import { FeaturePageHeader } from "@/components/feature-shell/feature-page-header"
import { FeaturePageShell } from "@/components/feature-shell/feature-page-shell"

/** Desktop layout for the in-app browser preview route. */
export function BrowserDesktopBody() {
  const t = useTranslations("browser")
  return (
    <FeaturePageShell
      storageId="browser"
      header={<FeaturePageHeader variant="compact" icon={<GlobeIcon />} title={t("title")} />}
    >
      <BrowserPreviewPane />
    </FeaturePageShell>
  )
}
