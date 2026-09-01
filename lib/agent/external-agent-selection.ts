/**
 * The single writer for "which external agent runs the next turn".
 *
 * Two stores answer that question and neither derives from the other:
 *
 *   - `useAgentRuntimeStore.runtimeRef` is what chat dispatch reads.
 *   - `useExternalAgentStore.activeAgentId` is what the manager UI, the
 *     `useExternalAgent` hook, and the Agent-Team workspace read.
 *
 * Writing one without the other is how "the manager shows Codex selected while
 * the composer dispatches to Gemini" happens. The manager's agent card wrote
 * only the second, so picking an agent there had no effect on chat at all, and
 * the composer's picker wrote only the first until it learned to mirror.
 * Everything that changes the selection goes through here instead, so the two
 * can only ever disagree if some new call site skips this module.
 *
 * This does NOT switch the runtime lane. Selecting an agent says *which* agent
 * an external turn goes to. Whether the next turn is external at all is the
 * composer's runtime chip's decision, so picking an agent in the manager must
 * not silently reroute a chat that is running on Cognia's own runtime.
 */

import { useAgentRuntimeStore } from "@/stores/agent"
import { useExternalAgentStore } from "@/stores/agent/external-agent-store"
import { BUILTIN_RUNTIME_REF } from "@/lib/ai/agent/runtime-catalog/types"

/** Point both stores at `agentId` (or clear the manager's selection with `null`). */
export function selectExternalAgent(agentId: string | null): void {
  useExternalAgentStore.getState().setActiveAgent(agentId)
  const runtime = useAgentRuntimeStore.getState()
  // Retarget the lane only when it is ALREADY external. Under the old flat
  // fields this wrote `externalAgentId` unconditionally, which looked like it
  // did more than it did: dispatch checks the lane first, so an id written
  // while the lane was builtin changed nothing until the chip switched lanes.
  // Restricting the write keeps that behaviour and makes it legible.
  if (agentId && runtime.runtimeRef.kind === "external") {
    runtime.setRuntimeRef({ kind: "external", agentId })
  }
}

/**
 * Drop the selection if, and only if, it points at `agentId`.
 *
 * Called when an agent is deleted or disabled. Without it the runtime store
 * keeps a dangling ref that outlives the record it names, and that ref is what
 * `use-claude-chat-controller` would still hand to the manager on the next
 * external turn.
 */
export function clearExternalAgentSelectionIfActive(agentId: string): void {
  const runtime = useAgentRuntimeStore.getState()
  const external = useExternalAgentStore.getState()
  if (runtime.runtimeRef.kind === "external" && runtime.runtimeRef.agentId === agentId) {
    // Fall back to the default lane rather than picking a replacement.
    // Inventing a different agent for the user is a worse surprise than
    // landing back on Cognia's own runtime.
    runtime.setRuntimeRef(BUILTIN_RUNTIME_REF)
  }
  // Sessions that pinned this agent are dangling too. Their composer chip would
  // repair itself on the next render, but a send from a chip that is not mounted
  // (a scheduled leg, a background run) would still be handed the dead id.
  for (const [sessionId, ref] of Object.entries(runtime.sessionRuntimeRefs)) {
    if (ref.kind === "external" && ref.agentId === agentId) {
      runtime.clearSessionRuntimeRef(sessionId)
    }
  }
  if (external.activeAgentId === agentId) external.setActiveAgent(null)
}
