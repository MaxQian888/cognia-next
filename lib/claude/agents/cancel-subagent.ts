/**
 * Single reuse point for cancelling a running subagent from the UI.
 *
 * Aborts the run's controller (registered by `dispatch-agent-handler`), also
 * cancels the background-run promise when the run was detached, and optimistically
 * marks the runtime-store node `cancelled` so the chat card reflects the action
 * immediately (the handler's abort `.catch` also records it — idempotent).
 */

import { requestCancelSubagentRun } from "./subagent-cancel-registry"
import { cancelRendererBackgroundRun } from "@/lib/background-tasks/renderer-subagent-registry"
import { useSubagentRuntimeStore } from "@/stores/agent/subagent-runtime-store"

export function cancelSubagentRun(id: string, opts?: { backgrounded?: boolean }): void {
  requestCancelSubagentRun(id)
  if (opts?.backgrounded) {
    cancelRendererBackgroundRun(id)
  }
  useSubagentRuntimeStore.getState().setStatus(id, "cancelled")
}
