"use client"

/**
 * Settings → Connectivity (ADR-0170).
 *
 * One master/detail surface for everything about how this device and a Host
 * reach each other: the local server, the relay and tunnel, pairing, the
 * remote-host registry, push, and sync. It replaced the "Mobile companion"
 * section (fifteen cards in five collapsible groups) and the "Remote hosts"
 * section (two tabs), whose deep links still land here through
 * `settings-shell.tsx`.
 *
 * Same shell as Logs, Gateway and External Bridge: a grouped rail, one panel,
 * the panel id in the URL.
 */

import { useCallback } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { useTranslations } from "next-intl"
import { RadioTowerIcon } from "lucide-react"

import { PanelTransition } from "@/components/settings/common/panel-transition"
import { SettingsMasterDetail } from "@/components/settings/common/settings-master-detail"

import { ConnectivityNav } from "./components/connectivity-nav"
import {
  CONNECTIVITY_NAV_GROUPS,
  CONNECTIVITY_PANEL_PARAM,
  resolveConnectivityPanel,
  type ConnectivityPanelId,
} from "./nav-config"
import { CloudRelayPanel } from "./panels/cloud-relay-panel"
import { LocalHostPanel } from "./panels/local-host-panel"
import { OverviewPanel } from "./panels/overview-panel"
import { PairingPanel } from "./panels/pairing-panel"
import { PushPanel } from "./panels/push-panel"
import { RemoteHostsPanel } from "./panels/remote-hosts-panel"
import { SyncPanel } from "./panels/sync-panel"

export function ConnectivitySection() {
  const t = useTranslations("settings.connectivity")
  const router = useRouter()
  const searchParams = useSearchParams()
  const activePanel = resolveConnectivityPanel(searchParams.get(CONNECTIVITY_PANEL_PARAM))

  const onSelect = useCallback(
    (id: ConnectivityPanelId) => {
      const next = new URLSearchParams(searchParams.toString())
      next.set(CONNECTIVITY_PANEL_PARAM, id)
      router.replace(`?${next.toString()}`, { scroll: false })
    },
    [router, searchParams]
  )

  const renderNav = (idPrefix: string) => (
    <ConnectivityNav
      groups={CONNECTIVITY_NAV_GROUPS}
      activeId={activePanel}
      onSelect={onSelect}
      idPrefix={idPrefix}
    />
  )

  const panel = (() => {
    switch (activePanel) {
      case "overview":
        return <OverviewPanel onNavigate={onSelect} />
      case "local-host":
        return <LocalHostPanel />
      case "cloud-relay":
        return <CloudRelayPanel />
      case "pairing":
        return <PairingPanel />
      case "remote-hosts":
        return <RemoteHostsPanel />
      case "push":
        return <PushPanel />
      case "sync":
        return <SyncPanel />
    }
  })()

  return (
    <div className="flex h-full min-h-0 flex-col gap-4" data-testid="connectivity-section">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3 border-b border-border/60 pb-4">
        <div className="flex min-w-0 items-start gap-2.5">
          <RadioTowerIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 space-y-0.5">
            <h2 className="text-base font-semibold tracking-tight">{t("title")}</h2>
            <p className="text-xs text-pretty text-muted-foreground">{t("description")}</p>
          </div>
        </div>
      </div>

      <SettingsMasterDetail
        nav={(slot) =>
          slot === "rail" ? renderNav("connectivity") : renderNav("connectivity-sheet")
        }
        navTitle={t("nav.title")}
        mobileTriggerLabel={t("nav.mobileTrigger")}
        activeKey={activePanel}
        activeLabel={t(`nav.items.${activePanel}.label`)}
        navWidth={260}
        triggerTestId="connectivity-mobile-nav-trigger"
      >
        <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border">
          <section
            aria-labelledby={`connectivity-panel-${activePanel}`}
            className="min-h-0 flex-1 overflow-y-auto p-4"
            data-testid="connectivity-panel-body"
            data-panel={activePanel}
          >
            <h3 id={`connectivity-panel-${activePanel}`} className="mb-3 text-sm font-semibold">
              {t(`nav.items.${activePanel}.label`)}
            </h3>
            <PanelTransition activeKey={activePanel}>{panel}</PanelTransition>
          </section>
        </div>
      </SettingsMasterDetail>
    </div>
  )
}

export default ConnectivitySection
