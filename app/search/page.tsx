"use client"

/**
 * Standalone (BYOK) web-search surface — a question box that runs a multi-provider
 * web search in-renderer and returns a model-synthesized, cited answer. Reachable
 * from the mobile `/me` screen (ME_ENTRIES `search` row). Reuses the `/me`
 * `SubPageShell` chrome so the back button returns to `/me`.
 *
 * All execution is client-side: the search providers fetch directly with the
 * user's keys, and the answer synthesis routes through the standalone provider
 * transport (`runStandaloneSearchAnswer`). No sidecar / paired desktop required.
 */

import { useTranslations } from "next-intl"

import { StandaloneSearchPanel } from "@/components/search/standalone-search-panel"
import { SubPageShell } from "@/components/mobile/me/sub-page-shell"

export default function StandaloneSearchPage() {
  const t = useTranslations("mobile.standaloneSearch")

  return (
    <SubPageShell title={t("title")} backAria={t("backAria")} testid="standalone-search-page">
      <StandaloneSearchPanel />
    </SubPageShell>
  )
}
