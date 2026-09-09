/**
 * URL contract for the AI Connections section.
 *
 * This section was the only master/detail settings pane that kept its whole
 * selection in Dexie (`ProviderUIPreferences`) instead of the URL, so
 * `?section=ai-connections` was the deepest link anyone could produce. Every
 * sibling already names its panel in a query param (subscription `?subTab=`,
 * connectivity `?connectivityPanel=`, ccswitch `?ccswitchTab=`), which is what
 * lets the settings finder jump straight to a panel.
 *
 * Ids live here rather than beside the components so the resolvers and the
 * shell can share one vocabulary without importing any JSX.
 */

import { panelIdSet, resolvePanelId } from "@/components/settings/common/resolve-panel-id"

/** Which top-level workspace the section is showing. */
export const AI_PANEL_PARAM = "aiPanel"
/** Which provider the detail pane is bound to. */
export const PROVIDER_PARAM = "provider"
/** Which tab of that provider is open. */
export const PROVIDER_TAB_PARAM = "providerTab"

export const AI_PANEL_IDS = ["providers", "routing", "compare"] as const
export type AiPanelId = (typeof AI_PANEL_IDS)[number]
export const DEFAULT_AI_PANEL: AiPanelId = "providers"

/**
 * Detail tabs, in strip order.
 *
 * `connect` and `usage` were `config` and `cost`. The retired `advanced` tab
 * held exactly one collapsible block (request parameters), which now lives
 * inside `connect` rather than behind a tab of its own.
 */
export const PROVIDER_TAB_IDS = ["connect", "models", "usage", "diagnostics"] as const
export type ProviderTabId = (typeof PROVIDER_TAB_IDS)[number]
export const DEFAULT_PROVIDER_TAB: ProviderTabId = "connect"

const AI_PANEL_ID_SET = panelIdSet(AI_PANEL_IDS.map((id) => ({ id })))
const PROVIDER_TAB_ID_SET = panelIdSet(PROVIDER_TAB_IDS.map((id) => ({ id })))

export function resolveAiPanel(raw: string | null | undefined): AiPanelId {
  return resolvePanelId(raw, AI_PANEL_ID_SET, DEFAULT_AI_PANEL)
}

export function resolveProviderTab(raw: string | null | undefined): ProviderTabId {
  return resolvePanelId(raw, PROVIDER_TAB_ID_SET, DEFAULT_PROVIDER_TAB)
}

/**
 * Cheap shape check for a provider id arriving from a URL.
 *
 * Deliberately not a catalog lookup. A custom provider the user deleted, or a
 * built-in this build does not carry, must still reach the detail pane so it
 * can say so. This only rejects values that could never be an id at all, which
 * keeps a hand-mangled link from being fed to `getElementById` or a store read.
 */
export function isProviderIdShaped(raw: string | null | undefined): raw is string {
  return typeof raw === "string" && raw.length > 0 && raw.length <= 128 && /^[\w.:-]+$/.test(raw)
}
