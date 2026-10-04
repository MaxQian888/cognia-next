"use client"

/**
 * Mobile External Agents page (ADR-0056). The agents on the paired Host —
 * the ones the chat composer's runtime menu offers on this phone — with the
 * add flow one tap away, and below them any agents configured only in the
 * desktop app's own store.
 *
 * Paired-only (`<PairedOnly>`, decision D2): external agents run on the Host.
 * The standalone (BYOK) webview has no Host, so the page would be dead UI.
 */

import Link from "next/link"
import { useTranslations } from "next-intl"
import { PlusIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { PairedOnly } from "@/components/mobile/me/paired-only"
import { SubPageShell } from "@/components/mobile/me/sub-page-shell"
import { DesktopLocalAgents } from "@/components/mobile/external-agents/desktop-local-agents"
import { HostAgentList } from "@/components/mobile/external-agents/host-agent-list"
import { ADD_EXTERNAL_AGENT_ROUTE } from "@/components/mobile/external-agents/routes"

export default function MobileExternalAgentsPage() {
  const t = useTranslations("mobile.externalAgents")
  return (
    <SubPageShell
      title={t("title")}
      backAria={t("backAria")}
      testid="mobile-external-agents-page"
      headerAccessory={
        <Button asChild variant="ghost" size="icon" aria-label={t("addAria")}>
          <Link href={ADD_EXTERNAL_AGENT_ROUTE} data-testid="external-agents-header-add">
            <PlusIcon className="size-5" />
          </Link>
        </Button>
      }
    >
      <PairedOnly>
        <div className="flex flex-col gap-6">
          <p className="px-1 text-xs text-muted-foreground" data-testid="external-agents-intro">
            {t("intro")}
          </p>
          <HostAgentList />
          <DesktopLocalAgents />
        </div>
      </PairedOnly>
    </SubPageShell>
  )
}
