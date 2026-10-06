/**
 * Does a transcript have more than one agent speaking in it (ADR-0218)?
 *
 * The message header's speaker line is hidden by default: in a one-agent chat
 * "Assistant" on every turn tells the reader nothing. It earns its place once
 * the answers come from different agents: the user switched composition
 * mid-session (Build, then Plan) or addressed a turn to another agent
 * (`@codex`, a Squad member). Then the name on each turn is the only thing
 * that tells them apart, so every assistant turn in that transcript shows it.
 *
 * Rooms (a named speaker per message) are handled by `MessageShell` itself;
 * this only answers for the turns of a single conversation.
 */

import type { UIMessage } from "ai"
import type { MessageRunMetadata } from "@/lib/chat/message-run-metadata"

/** The part of a UI or stored message the key reads. */
export interface AgentKeySource {
  role: UIMessage["role"]
  metadata?: unknown
}

/**
 * Which agent answered an assistant turn: the routed handle when the user
 * addressed it, else the composition stamped at seal. `undefined` for user
 * turns and for turns not stamped yet (streaming) or never stamped (older
 * transcripts), which then take no part in the count. Accepts a `UIMessage`
 * or a `StoredMessage`; the transcript projection stamps it on previews.
 */
export function assistantAgentKey(message: AgentKeySource): string | undefined {
  if (message.role !== "assistant") return undefined
  const run = (message.metadata as { run?: unknown } | undefined)?.run
  if (!run || typeof run !== "object") return undefined
  const { route, agent } = run as Pick<MessageRunMetadata, "route" | "agent">
  const handle = route?.handle?.trim()
  if (handle) return `route:${handle.toLowerCase()}`
  const presetId = agent?.presetId?.trim()
  return presetId ? `preset:${presetId}` : undefined
}

/** True once two of the keys differ; `undefined` keys are skipped. */
export function hasMultipleAgentKeys(keys: Iterable<string | undefined>): boolean {
  let first: string | undefined
  for (const key of keys) {
    if (key === undefined) continue
    if (first === undefined) first = key
    else if (key !== first) return true
  }
  return false
}

/** True once two assistant turns were answered by different agents. */
export function transcriptHasMultipleAgents(messages: readonly AgentKeySource[]): boolean {
  return hasMultipleAgentKeys(messages.map(assistantAgentKey))
}
