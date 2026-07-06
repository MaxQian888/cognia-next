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

/** Read a text file for the ACP `fs/read_text_file` capability. */
export async function agentReadTextFile(path: string): Promise<string> {
  if (isTauri()) {
    const { readTextFile } = await import("@tauri-apps/plugin-fs")
    return readTextFile(path)
  }
  if (isHeadlessHost()) {
    const fs = await import(/* webpackIgnore: true */ "node:fs/promises")
    return fs.readFile(path, "utf8")
  }
  throw new Error("File system access not available in browser")
}

/** Write a text file for the ACP `fs/write_text_file` capability. */
export async function agentWriteTextFile(path: string, content: string): Promise<void> {
  if (isTauri()) {
    const { writeTextFile } = await import("@tauri-apps/plugin-fs")
    await writeTextFile(path, content)
    return
  }
  if (isHeadlessHost()) {
    const fs = await import(/* webpackIgnore: true */ "node:fs/promises")
    await fs.writeFile(path, content, "utf8")
    return
  }
  throw new Error("File system access not available in browser")
}
