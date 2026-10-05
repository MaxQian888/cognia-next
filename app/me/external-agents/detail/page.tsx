"use client"

/**
 * One Host external-agent configuration: its readiness, its settings, and
 * duplicate / remove (ADR-0216). The configuration arrives as `?id=` because
 * the app is a static export: a dynamic segment would need every id the Host
 * will ever mint known at build time.
 *
 * Paired-only, like the list it is opened from: the configuration lives on the
 * Host, and the standalone webview has none.
 */

import { Suspense } from "react"
import { useSearchParams } from "next/navigation"
import { useTranslations } from "next-intl"

import { PairedOnly } from "@/components/mobile/me/paired-only"
import { SubPageShell } from "@/components/mobile/me/sub-page-shell"
import { ExternalAgentScreenSkeleton } from "@/components/mobile/external-agents/external-agent-screen-skeleton"
import { HostAgentDetail } from "@/components/mobile/external-agents/host-agent-detail"
import { EXTERNAL_AGENTS_ROUTE } from "@/components/mobile/external-agents/routes"

function DetailScreen() {
  const t = useTranslations("mobile.externalAgents")
  const configId = useSearchParams().get("id") ?? ""
  return (
    <SubPageShell
      title={t("detailTitle")}
      backAria={t("backToListAria")}
      backHref={EXTERNAL_AGENTS_ROUTE}
      testid="mobile-external-agent-detail-page"
    >
      <PairedOnly>
        {/* Keyed so moving to a sibling (or a fresh copy) starts a fresh screen. */}
        <HostAgentDetail key={configId} configId={configId} />
      </PairedOnly>
    </SubPageShell>
  )
}

export default function MobileExternalAgentDetailPage() {
  // `useSearchParams` needs a Suspense boundary above it in a static export.
  return (
    <Suspense
      fallback={<ExternalAgentScreenSkeleton testid="mobile-external-agent-detail-loading" />}
    >
      <DetailScreen />
    </Suspense>
  )
}
