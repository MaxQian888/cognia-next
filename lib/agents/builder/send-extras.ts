/**
 * What an agent-builder turn adds to its send options (ADR-0220): the builder
 * tools, the session-stable protocol, and the live draft as a per-turn
 * section. One entry point so `resolveSendOptions` carries a single gated
 * block, as it does for project coordination.
 */

import type { ChatSession } from "@cognia/agent-config-types"
import {
  buildAgentBuilderManifestEntries,
  type AgentBuilderManifestEntry,
} from "@/lib/claude/agent-builder-builtin-tools"
import { AGENT_BUILDER_PROTOCOL } from "./builder-protocol"
import { renderDraftForModel, type DraftCatalogs } from "./draft-ops"
import { isAgentBuilderSession } from "./builder-session"

export interface AgentBuilderSendExtras {
  pluginTools: AgentBuilderManifestEntry[]
  /** Session-stable: safe in the cached prompt prefix. */
  protocol: string
  /** Changes every turn: belongs in the dynamic tail. */
  dynamicSection: string
}

export async function resolveAgentBuilderSendExtras(
  session: Pick<ChatSession, "kind" | "agentBuilder">,
  catalogs: () => Promise<DraftCatalogs>
): Promise<AgentBuilderSendExtras | undefined> {
  if (!isAgentBuilderSession(session) || !session.agentBuilder) return undefined
  const state = session.agentBuilder
  const draft =
    state.status === "created"
      ? `The agent was created (id ${state.createdCharacterId ?? "unknown"}). The draft is closed; point the user to the agent's Settings for further changes.`
      : JSON.stringify(renderDraftForModel(state.draft, await catalogs()), null, 2)
  return {
    pluginTools: buildAgentBuilderManifestEntries(),
    protocol: AGENT_BUILDER_PROTOCOL,
    dynamicSection: `## Current agent draft (revision ${state.revision}, last edited by ${state.editedBy})\n\n${draft}`,
  }
}
