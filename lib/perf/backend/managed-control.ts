/**
 * Managed-process control router.
 *
 * Lifecycle control is split by ownership so that each action runs where the
 * process's authoritative state lives:
 *
 *  - **External agents** are driven through the renderer's `ExternalAgentManager`
 *    (`disconnect` / `reconnect`). Going through the manager — instead of the
 *    raw `kill_external_agent` Tauri command — keeps the JS connection state and
 *    the store in sync, which is the whole point of the external-agent
 *    state-management fix. Restart reuses `reconnect` (disconnect + connect with
 *    the existing config + orphan-reclaim logic).
 *  - **Rust-supervised subsystems** (chat sidecar, ACP + PTY terminals, MCP
 *    server) are controlled through the unified `control_managed_process`
 *    command, which dispatches to the owning subsystem's kill/stop path.
 */

import { getExternalAgentManager } from "@/lib/ai/agent/external/manager"
import { controlManagedProcess } from "./commands"
import type { ManagedControlAction, ManagedProcess } from "./types"

/**
 * Run `action` against a managed process, routing external agents through the
 * renderer manager and everything else through the native command. Rejects if
 * the underlying operation fails so callers can surface a toast.
 */
export async function controlManaged(
  target: Pick<ManagedProcess, "subsystem" | "id">,
  action: ManagedControlAction
): Promise<void> {
  if (target.subsystem === "externalAgent") {
    const manager = getExternalAgentManager()
    if (action === "restart") {
      await manager.reconnect(target.id)
    } else {
      await manager.disconnect(target.id)
    }
    return
  }
  await controlManagedProcess(target.subsystem, target.id, action)
}
