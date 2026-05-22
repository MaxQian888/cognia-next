"use client"

/**
 * Per-tab agent trust gate. Thin wrapper over the existing
 * `PluginConsentBroker` — we encode the (chatSessionId, tabId) scope as
 * a synthetic `pluginId` so the broker + overlay both work unchanged.
 *
 * The grant cache uses the broker's existing `sessionGrants` set keyed by
 * `${pluginId}:${permission}`. The lifetime is the same as a plugin grant
 * — in-memory only, cleared on killswitch / reload — which matches the
 * "trust this tab for this chat session" semantics from the plan.
 *
 * Why not extend `PluginPermission`? `terminal:write` is already in the
 * union (used by VS Code-style extensions that drive the dock). We reuse
 * it for the agent path. The pluginId namespace `agent:<chatId>:<tabId>`
 * keeps grants scoped correctly.
 */

import {
  getPluginConsentBroker,
  type PluginConsentBroker,
} from "@/lib/plugin/security/consent-broker"
import type { PluginPermission } from "@/types/plugin"

/** Permission key — reused from the plugin union. */
const TRUST_PERMISSION: PluginPermission = "terminal:write"

/** Build the synthetic `pluginId` used as the broker grant scope. */
export function agentTrustPluginId(chatSessionId: string, tabId: string): string {
  return `agent:${chatSessionId}:${tabId}`
}

export interface RequestAgentTrustInput {
  chatSessionId: string
  tabId: string
  /** Visible-to-user tab title (used inside the consent prompt's reason). */
  tabTitle: string
  /** Short preview of the command the agent will run — included in the prompt body. */
  commandPreview: string
  /** Optional broker override for tests. */
  broker?: PluginConsentBroker
}

/**
 * Open the consent overlay and return whether the user allowed the
 * agent to write into the tab. Once "Always allow this session" is
 * chosen, subsequent requests for the same (chatSessionId, tabId)
 * resolve `true` immediately without prompting.
 */
export async function requestAgentTrust(input: RequestAgentTrustInput): Promise<boolean> {
  const broker = input.broker ?? getPluginConsentBroker()
  return broker.request({
    pluginId: agentTrustPluginId(input.chatSessionId, input.tabId),
    permission: TRUST_PERMISSION,
    reason: `Agent will run in "${input.tabTitle}": ${truncatePreview(input.commandPreview)}`,
  })
}

/** Read-only check — true when the user has already granted trust for this scope. */
export function isAgentTrusted(
  chatSessionId: string,
  tabId: string,
  broker: PluginConsentBroker = getPluginConsentBroker()
): boolean {
  return broker.hasSessionGrant(agentTrustPluginId(chatSessionId, tabId), TRUST_PERMISSION)
}

function truncatePreview(text: string, max = 80): string {
  if (text.length <= max) return text
  return text.slice(0, max - 1) + "…"
}
