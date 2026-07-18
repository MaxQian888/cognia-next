/**
 * Host indirection for the external-agent process plane (ADR-0059 T-A10).
 *
 * `acp-client.ts` historically bound to Tauri statically (`invoke`, `listen`,
 * `@tauri-apps/plugin-fs`). This module collapses those into host-resolved
 * calls so the SAME orchestration drives external agents on:
 *
 * - **Tauri desktop** — `invoke`/`listen`, exactly as before (lazy imports;
 *   jest mocks of `@tauri-apps/*` keep working).
 * - **The headless brain** — the process `Transport`
 *   (`CompanionTransport` → the R11 service-scope RPC arms + the frozen
 *   `external-agent://*` events over `/ws/v1/events`).
 *
 * Terminal support stays desktop-only (no headless `acp_terminal_*` arms) —
 * the ACP capability advertisement reflects that.
 */
// `isTauri` via @/lib/utils (the app-wide re-export the existing agent test
// suites mock); `isHeadlessHost` from the platform leaf.
import { isHeadlessHost } from "@/lib/platform/detect"
import { isPathUnderRoot } from "@/lib/sandbox/policy-bridge"
import { isTauri } from "@/lib/utils"

/** Whether this host can spawn/drive external agent processes at all. */
export function supportsExternalAgents(): boolean {
  return isTauri() || isHeadlessHost()
}

/** Whether the ACP fs capability (read/write text file) is available. */
export function supportsAgentFs(): boolean {
  return isTauri() || isHeadlessHost()
}

/** Whether the ACP terminal capability is available (desktop-only). */
export function supportsAgentTerminal(): boolean {
  return isTauri()
}

/** Invoke a process-plane command on whichever host is present. */
export async function agentInvoke<T>(name: string, args: Record<string, unknown>): Promise<T> {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core")
    return invoke<T>(name, args)
  }
  const { transport } = await import("@/lib/tauri/transport-instance")
  return transport.call<T>(name, args)
}

/**
 * Subscribe to a process-plane event channel. The handler receives the RAW
 * payload (both hosts deliver the identical frozen shapes).
 */
export async function agentListen<T>(
  event: string,
  handler: (payload: T) => void
): Promise<() => void> {
  if (isTauri()) {
    const { listen } = await import("@tauri-apps/api/event")
    return listen<T>(event, (e) => handler(e.payload))
  }
  const { transport } = await import("@/lib/tauri/transport-instance")
  return transport.subscribe<T>(event, handler)
}

function resolveSessionWorkspacePath(
  path: string,
  allowedRoots: string[]
): { root: string; relPath: string } {
  const root = allowedRoots.find((candidate) => {
    return /^[A-Za-z]:[\\/]|^\\\\/.test(candidate)
      ? isPathUnderRoot(path, candidate, "win32")
      : isPathUnderRoot(path, candidate)
  })
  if (!root) {
    throw new Error(`Path is outside the ACP session workspace roots: ${path}`)
  }
  const normalizedRoot = root.replace(/[\\/]+$/, "")
  const relPath = path.slice(normalizedRoot.length).replace(/^[\\/]+/, "")
  return { root, relPath }
}

/** Read a text file through the host's symlink-aware workspace boundary. */
export async function agentReadTextFile(path: string, allowedRoots: string[]): Promise<string> {
  if (!supportsAgentFs()) {
    throw new Error("File system access not available in browser")
  }
  const { root, relPath } = resolveSessionWorkspacePath(path, allowedRoots)
  return agentInvoke<string>("fs_read_workspace_file", { root, relPath, maxBytes: undefined })
}

/** Write a text file through the host's symlink-aware workspace boundary. */
export async function agentWriteTextFile(
  path: string,
  content: string,
  allowedRoots: string[]
): Promise<void> {
  if (!supportsAgentFs()) {
    throw new Error("File system access not available in browser")
  }
  const { root, relPath } = resolveSessionWorkspacePath(path, allowedRoots)
  await agentInvoke("fs_write_workspace_file", { root, relPath, content })
}
