/**
 * Panels of the Settings → Built-in Agent Runtime master/detail pane.
 *
 * This section used to be five top-level tabs whose bodies were stacks of
 * cards, so "where do I set the permission mode?" meant reading five tab labels
 * and then scanning a wall of boxes. Same five areas, but as a labelled nav
 * with a one-line description each — the shape Providers, Gateway and External
 * Bridge already use.
 *
 * The deep-link param stays `agentRuntimeTab`: `sidecar-tab.tsx`'s sessions
 * counter and any bookmarked URL already point at it, and renaming it would
 * silently drop them onto the default panel.
 *
 * Plain data so the nav, the deep-link resolver and the tests all read one list.
 */

import {
  BotMessageSquareIcon,
  HistoryIcon,
  ServerCogIcon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
} from "lucide-react"

import { panelIdSet, resolvePanelId } from "@/components/settings/common/resolve-panel-id"
import type {
  SettingsNavGroup,
  SettingsNavItem,
} from "@/components/settings/common/settings-panel-nav"

export type AgentRuntimePanelId = "defaults" | "permissions" | "sessions" | "sidecar" | "a2ui"

export type AgentRuntimeNavGroupId = "behaviorGroup" | "runtimeGroup"

export type AgentRuntimeNavItem = SettingsNavItem<AgentRuntimePanelId>

export type AgentRuntimeNavGroup = SettingsNavGroup<AgentRuntimePanelId, AgentRuntimeNavGroupId>

// Group ids are suffixed so `nav.groups.behaviorGroup` never reads as
// `nav.items.behavior` at a glance (the convention Appearance established).
export const AGENT_RUNTIME_NAV_GROUPS: readonly AgentRuntimeNavGroup[] = [
  {
    id: "behaviorGroup",
    items: [
      { id: "defaults", icon: SlidersHorizontalIcon },
      { id: "permissions", icon: ShieldCheckIcon },
    ],
  },
  {
    id: "runtimeGroup",
    items: [
      { id: "sessions", icon: HistoryIcon },
      { id: "sidecar", icon: ServerCogIcon },
      { id: "a2ui", icon: BotMessageSquareIcon },
    ],
  },
]

export const AGENT_RUNTIME_NAV_ITEMS: readonly AgentRuntimeNavItem[] =
  AGENT_RUNTIME_NAV_GROUPS.flatMap((group) => group.items)

const PANEL_IDS = panelIdSet(AGENT_RUNTIME_NAV_ITEMS)

/** Kept as the legacy tab param name so existing deep links still resolve. */
export const AGENT_RUNTIME_PANEL_PARAM = "agentRuntimeTab"

export const DEFAULT_AGENT_RUNTIME_PANEL: AgentRuntimePanelId = "defaults"

/** Narrow an untrusted deep-link value, falling back to the defaults panel. */
export function resolveAgentRuntimePanel(raw: string | null | undefined): AgentRuntimePanelId {
  return resolvePanelId(raw, PANEL_IDS, DEFAULT_AGENT_RUNTIME_PANEL)
}
