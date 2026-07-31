"use client"

import { useTranslations } from "next-intl"

import { SubPageShell } from "@/components/mobile/me/sub-page-shell"
import { ModelCatalogSection } from "@/components/settings/provider/model-catalog-section"

export default function MobileModelCatalogPage() {
  const t = useTranslations("modelCatalog")

  return (
    <SubPageShell title={t("title")} backAria={t("backAria")} testid="mobile-model-catalog-page">
      <div className="flex min-h-[70dvh] flex-1">
        <ModelCatalogSection />
      </div>
    </SubPageShell>
  )
}
