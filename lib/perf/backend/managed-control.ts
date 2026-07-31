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
 *  - **Rust-supervised subsystems** (chat sidecar, ACP + PTY terminals, headless
 *    shells, MCP server, Node plugin hosts, the cloudflared tunnel) are
 *    controlled through the unified `control_managed_process` command, which
 *    dispatches to the owning subsystem's kill/stop path. New subsystems need
 *    no change here — they fall through to that default.
 *  - **code-server** is Rust-supervised like the rest, but it additionally owns
 *    a native webview floating above the DOM. Killing only the process would
 *    leave that pane pinned over the app showing a dead page, so the renderer
 *    half is torn down here as well.
 */

import { getExternalAgentManager } from "@/lib/ai/agent/external/manager"
import { destroyCodeServerPane } from "@/lib/codeserver/pane-manager"
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
  if (target.subsystem === "codeServer") {
    // Both actions take the loopback port the pane is navigated to away — a
    // restart comes back on a fresh one — so the webview cannot outlive the
    // call. Done first: the stop happens either way, and a restart only returns
    // once the replacement is healthy, which would leave a dead page on screen
    // for the whole spawn.
    await destroyCodeServerPane()
  }
  await controlManagedProcess(target.subsystem, target.id, action)
}
