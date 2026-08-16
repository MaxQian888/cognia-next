/**
 * The single writer for "which external agent runs the next turn".
 *
 * Two stores answer that question and neither derives from the other:
 *
 *   - `useAgentRuntimeStore.externalAgentId` is what chat dispatch reads
 *     (`hooks/chat/use-claude-chat-controller.ts` → `manualExternal` branch).
 *   - `useExternalAgentStore.activeAgentId` is what the manager UI, the
 *     `useExternalAgent` hook, and the Agent-Team workspace read.
 *
 * Writing one without the other is how "the manager shows Codex selected while
 * the composer dispatches to Gemini" happens — the manager's agent card wrote
 * only the second, so picking an agent there had no effect on chat at all, and
 * the composer's picker wrote only the first until it learned to mirror.
 * Everything that changes the selection goes through here instead, so the two
 * can only ever disagree if some new call site skips this module.
 *
 * This does NOT switch the runtime lane. Selecting an agent says *which* agent
 * an external turn goes to; whether the next turn is external at all stays with
 * `runtime`, which only the composer's runtime chip sets. Picking an agent in
 * the manager must not silently reroute a chat that is running on the Claude
 * SDK.
 */

import { useAgentRuntimeStore } from "@/stores/agent"
import { useExternalAgentStore } from "@/stores/agent/external-agent-store"

/** Point both stores at `agentId` (or clear the selection with `null`). */
export function selectExternalAgent(agentId: string | null): void {
  useAgentRuntimeStore.getState().setExternalAgentId(agentId)
  useExternalAgentStore.getState().setActiveAgent(agentId)
}

/**
 * Drop the selection if — and only if — it points at `agentId`.
 *
 * Called when an agent is deleted or disabled. Without it the runtime store
 * keeps a dangling id that outlives the record it names: the composer chip
 * repairs its own display, but a persisted stale id is what
 * `use-claude-chat-controller` would still hand to the manager on the next
 * external turn.
 */
export function clearExternalAgentSelectionIfActive(agentId: string): void {
  const runtime = useAgentRuntimeStore.getState()
  const external = useExternalAgentStore.getState()
  if (runtime.externalAgentId === agentId) runtime.setExternalAgentId(null)
  if (external.activeAgentId === agentId) external.setActiveAgent(null)
}
