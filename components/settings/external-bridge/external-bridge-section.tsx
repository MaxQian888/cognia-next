"use client"

/**
 * External Bridge settings — the MCP server's full surface.
 *
 * Was a single file stacking six cards in one scroll (the header even predicted
 * "per-component split can land in Phase 2 once the UI grows" — it grew). Now a
 * master/detail shell: this file owns the persisted settings, the deep link and
 * the layout; the panels live under `./panels/`.
 *
 * Layout matches `../gateway/gateway-section.tsx` exactly — the two sections are
 * adjacent in the settings sidebar, so any divergence reads as a bug.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { useTranslations } from "next-intl"
import { WebhookIcon } from "lucide-react"

import { Label } from "@/components/ui/label"
import { PanelTransition } from "@/components/settings/common/panel-transition"
import { SettingsMasterDetail } from "@/components/settings/common/settings-master-detail"
import { getSettings, saveSettings } from "@/lib/db/settings"
import {
  ALL_BRIDGE_SCOPES,
  DEFAULT_EXTERNAL_BRIDGE_SETTINGS,
  type ExternalBridgeSettings,
} from "@/types/wiki"

import { BridgeNav, type BridgeNavBadge } from "./components/bridge-nav"
import {
  BRIDGE_NAV_GROUPS,
  BRIDGE_PANEL_PARAM,
  resolveBridgePanel,
  type BridgePanelId,
} from "./nav-config"
import { BridgeServerPanel } from "./panels/server-panel"
import { BridgeScopesPanel } from "./panels/scopes-panel"
import { BridgeWikiPanel } from "./panels/wiki-panel"
import { BridgeInboundPanel } from "./panels/inbound-panel"
import { BridgeSetupPanel } from "./panels/setup-panel"
import { BridgeAuditPanel } from "./panels/audit-panel"

export function ExternalBridgeSection() {
  const t = useTranslations("settings.externalBridge")
  const router = useRouter()
  const searchParams = useSearchParams()
  const [settings, setSettings] = useState<ExternalBridgeSettings | undefined>(undefined)
  const [loading, setLoading] = useState(true)

  const activePanel = resolveBridgePanel(searchParams.get(BRIDGE_PANEL_PARAM))

  useEffect(() => {
    let cancelled = false
    getSettings()
      .then((row) => {
        if (cancelled) return
        setSettings(row.externalBridge ?? { ...DEFAULT_EXTERNAL_BRIDGE_SETTINGS })
        setLoading(false)
      })
      .catch(() => setLoading(false))
    return () => {
      cancelled = true
    }
  }, [])

  const persist = useCallback(async (next: ExternalBridgeSettings) => {
    setSettings(next)
    await saveSettings({ externalBridge: next })
  }, [])

  const onSelect = useCallback(
    (id: BridgePanelId) => {
      const next = new URLSearchParams(searchParams.toString())
      next.set(BRIDGE_PANEL_PARAM, id)
      router.replace(`?${next.toString()}`, { scroll: false })
    },
    [router, searchParams]
  )

  const badges = useMemo(() => {
    const result: Partial<Record<BridgePanelId, BridgeNavBadge>> = {}
    if (settings) {
      const granted = ALL_BRIDGE_SCOPES.filter((s) => settings.enabledScopes.includes(s)).length
      result.scopes = {
        text: `${granted}/${ALL_BRIDGE_SCOPES.length}`,
        variant: "secondary",
        ariaLabel: t("nav.badgeScopesAria", { granted, total: ALL_BRIDGE_SCOPES.length }),
      }
    }
    return result
  }, [settings, t])

  if (loading || !settings) {
    return <div className="p-4 text-sm text-muted-foreground">{t("loading")}</div>
  }

  const navNode = (
    <BridgeNav
      groups={BRIDGE_NAV_GROUPS}
      activeId={activePanel}
      onSelect={onSelect}
      badges={badges}
    />
  )

  return (
    <div className="flex h-full min-h-0 flex-col gap-4" data-testid="external-bridge-section">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <Label className="flex items-center gap-2">
            <WebhookIcon className="size-4" />
            {t("title")}
          </Label>
          <p className="text-xs text-muted-foreground">{t("description")}</p>
        </div>
      </div>

      <SettingsMasterDetail
        nav={() => navNode}
        navTitle={t("nav.title")}
        mobileTriggerLabel={t("nav.mobileTrigger")}
        activeKey={activePanel}
        activeLabel={t(`nav.items.${activePanel}.label`)}
        navWidth={320}
        triggerTestId="bridge-mobile-nav-trigger"
      >
        <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border">
          <div
            className="min-h-0 flex-1 overflow-y-auto p-3 @container/bridge-pane"
            data-testid="bridge-panel-body"
          >
            <PanelTransition activeKey={activePanel}>
              {renderPanel(activePanel, settings, persist)}
            </PanelTransition>
          </div>
        </div>
      </SettingsMasterDetail>
    </div>
  )
}

function renderPanel(
  panel: BridgePanelId,
  settings: ExternalBridgeSettings,
  persist: (next: ExternalBridgeSettings) => Promise<void>
) {
  const onChange = (next: ExternalBridgeSettings) => void persist(next)
  switch (panel) {
    case "server":
      return <BridgeServerPanel settings={settings} onChange={onChange} />
    case "scopes":
      return <BridgeScopesPanel settings={settings} onChange={onChange} />
    case "wiki":
      return <BridgeWikiPanel />
    case "inbound":
      return <BridgeInboundPanel />
    case "setup":
      return <BridgeSetupPanel settings={settings} />
    case "audit":
      return <BridgeAuditPanel />
  }
}
