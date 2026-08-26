"use client"

/**
 * Built-in Agent Runtime — master/detail shell for the in-process Claude SDK
 * runtime.
 *
 * Was five top-level tabs over stacks of cards. Tabs hid the descriptions that
 * say what each area actually governs, and the cards nested a border per group
 * inside the settings pane, so a page of switches read as a page of boxes. It
 * is now the same master/detail shape as Providers / Gateway / External Bridge:
 * `SettingsMasterDetail` owns the nav/detail split: the rail tiers off
 * the pane's own width (full → compact → icon → drawer) rather than the
 * viewport, which this pane never gets — it is the window minus the app rail
 * minus the settings sidebar. The detail pane owns its scroll, and the panels themselves are
 * flat `SettingsStack`s.
 *
 * The deep-link param is unchanged (`?agentRuntimeTab=`), so bookmarks and the
 * Sidecar panel's sessions counter still land on the right panel.
 */

import { useCallback } from "react"
import { useTranslations } from "next-intl"
import { useRouter, useSearchParams } from "next/navigation"
import { WorkflowIcon } from "lucide-react"

import { PanelTransition } from "@/components/settings/common/panel-transition"
import { SettingsMasterDetail } from "@/components/settings/common/settings-master-detail"
import {
  CLAUDE_CODE_RELATED,
  RelatedSectionsStrip,
} from "@/components/settings/common/related-sections-strip"

import { AgentRuntimeNav } from "./agent-runtime-nav"
import {
  AGENT_RUNTIME_NAV_GROUPS,
  AGENT_RUNTIME_PANEL_PARAM,
  resolveAgentRuntimePanel,
  type AgentRuntimePanelId,
} from "./nav-config"
import { DefaultsTab } from "./tabs/defaults-tab"
import { PermissionsToolsTab } from "./tabs/permissions-tools-tab"
import { SidecarTab } from "./tabs/sidecar-tab"
import { A2UIBridgeTab } from "./tabs/a2ui-bridge-tab"
import { SessionsTab } from "./tabs/sessions-tab"

/** Re-exported under the old name — external callers type tabs, not panels. */
export type AgentRuntimeTabId = AgentRuntimePanelId

export function AgentRuntimeSection() {
  const t = useTranslations("settings.agentRuntimeSection")
  const router = useRouter()
  const params = useSearchParams()

  const activePanel = resolveAgentRuntimePanel(params.get(AGENT_RUNTIME_PANEL_PARAM))

  const onSelect = useCallback(
    (id: AgentRuntimePanelId) => {
      const next = new URLSearchParams(params.toString())
      next.set(AGENT_RUNTIME_PANEL_PARAM, id)
      router.replace(`?${next.toString()}`, { scroll: false })
    },
    [router, params]
  )

  // Two mounts, two prefixes: the desktop rail is only `display:none` below
  // `md`, so it and the Sheet copy are both in the tree while the Sheet is
  // open, and they must not share one shared-layout pill id.
  const renderNav = (idPrefix: string) => (
    <AgentRuntimeNav
      groups={AGENT_RUNTIME_NAV_GROUPS}
      activeId={activePanel}
      onSelect={onSelect}
      idPrefix={idPrefix}
    />
  )

  return (
    <div className="flex h-full min-h-0 flex-col gap-4" data-testid="agent-runtime-section">
      <div className="flex min-w-0 items-start gap-2.5">
        <WorkflowIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 space-y-0.5">
          <h2 className="text-base font-semibold tracking-tight">{t("title")}</h2>
          <p className="text-xs text-pretty text-muted-foreground">{t("description")}</p>
        </div>
      </div>

      <RelatedSectionsStrip current="agent-runtime" targets={CLAUDE_CODE_RELATED} />

      <SettingsMasterDetail
        nav={(slot) =>
          slot === "rail" ? renderNav("agent-runtime") : renderNav("agent-runtime-sheet")
        }
        navTitle={t("nav.title")}
        mobileTriggerLabel={t("nav.mobileTrigger")}
        activeKey={activePanel}
        activeLabel={t(`nav.items.${activePanel}.label`)}
        navWidth={280}
        triggerTestId="agent-runtime-mobile-nav-trigger"
      >
        {/* The pane is a fraction of the window, so panel internals size off
            `@container/settings-stack` (declared by `SettingsStack`) rather
            than the viewport. */}
        <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border">
          <div
            className="min-h-0 flex-1 overflow-y-auto p-4"
            data-testid="agent-runtime-panel-body"
          >
            <PanelTransition activeKey={activePanel}>
              <AgentRuntimePanelBody panel={activePanel} />
            </PanelTransition>
          </div>
        </div>
      </SettingsMasterDetail>
    </div>
  )
}

function AgentRuntimePanelBody({ panel }: { panel: AgentRuntimePanelId }) {
  switch (panel) {
    case "defaults":
      return <DefaultsTab />
    case "permissions":
      return <PermissionsToolsTab />
    case "sessions":
      return <SessionsTab />
    case "sidecar":
      return <SidecarTab />
    case "a2ui":
      return <A2UIBridgeTab />
  }
}

export default AgentRuntimeSection
