/**
 * Single reuse point for cancelling a running subagent from the UI.
 *
 * Aborts the run's controller (registered by `dispatch-agent-handler`), also
 * cancels the background-run promise when the run was detached, and
 * marks the runtime-store node `cancelled` so the chat card reflects the action
 * after its durable receipt (the terminal handler is idempotent).
 */

import { requestCancelSubagentRunAndWait } from "./subagent-cancel-registry"
import {
  cancelRendererBackgroundRunAndWait,
  hasRendererBackgroundRun,
} from "@/lib/background-tasks/renderer-subagent-registry"
import { useSubagentRuntimeStore } from "@/stores/agent/subagent-runtime-store"

export async function cancelSubagentRun(
  id: string,
  opts?: { backgrounded?: boolean; reason?: string }
): Promise<boolean> {
  // Both registries point at one adapter. Invoke it once, and await the
  // persisted cancellation intent before projecting a terminal UI state.
  const cancelled =
    opts?.backgrounded || hasRendererBackgroundRun(id)
      ? await cancelRendererBackgroundRunAndWait(id)
      : await requestCancelSubagentRunAndWait(id, opts?.reason)
  if (cancelled) useSubagentRuntimeStore.getState().setStatus(id, "cancelled")
  return cancelled
}
