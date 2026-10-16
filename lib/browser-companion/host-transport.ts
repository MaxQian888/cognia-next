/**
 * How the Host reaches its own paired browsers' device sockets (ADR-0228 §5–§6).
 *
 * Two kinds of process host a Browser Companion conversation, and both serve
 * the `/ws/browser-companion` socket from their own companion server:
 *
 * - the desktop app, which asks its server over Tauri IPC — always its own,
 *   even while the window is driving a remote Host, because the browser it
 *   pairs with is the one on this machine;
 * - the headless brain (`cognia-agent serve` beside `cognia-server`), which
 *   asks over its own server's service plane — the transport the serve boot
 *   installs (`rpc/service_plane.rs` answers these three for it alone).
 *
 * Anywhere else — a phone, a browser tab — there is no socket to reach, and
 * {@link hostServesBrowserSockets} says so, so agent mode is never offered on
 * a guess.
 */

import { isHeadlessHost } from "@/lib/platform/detect"
import { isTauri } from "@/lib/tauri"
import { localTransport, transport } from "@/lib/tauri/transport-instance"
import type { Transport } from "@/lib/tauri/transport-types"

/** Whether this process is a Host that serves its paired browsers' sockets. */
export function hostServesBrowserSockets(): boolean {
  return isTauri() || isHeadlessHost()
}

/** The transport to this process's own companion server. */
export function browserSocketTransport(): Transport {
  return isTauri() ? localTransport : transport
}

/** One paired browser's connection and `browser.drive` state, as the Host sees it. */
export interface BrowserSocketStatus {
  connected: boolean
  driveAllowed: boolean
}

export function browserSocketStatus(deviceId: string): Promise<BrowserSocketStatus> {
  return browserSocketTransport().call<BrowserSocketStatus>("companion_browser_extension_status", {
    deviceId,
  })
}

/** Hint one browser that its submissions moved, so its badge refreshes now. */
export async function notifyBrowserSocket(deviceId: string): Promise<void> {
  await browserSocketTransport().call<void>("companion_browser_extension_notify", { deviceId })
}

export interface BrowserSocketCall {
  deviceId: string
  operation: string
  args: Record<string, unknown>
  timeoutMs: number
}

/**
 * The operations that only look (`READ_OPERATIONS` in
 * `crates/cognia-companion/src/ws_browser_companion.rs`, which the test pins
 * this list to). Off the desktop they travel as a read the Host's idempotency
 * ledger never stores — snapshots, screenshots and cookie values must not be
 * written to the security store on every look — while an action keeps its
 * receipt so a retry is not run twice. The desktop's IPC has no ledger, so it
 * sends every operation the one way.
 */
export const BROWSER_READ_OPERATIONS: ReadonlySet<string> = new Set([
  "snapshot",
  "read_console",
  "read_network",
  "get_page",
  "list_pages",
  "downloads",
  "wait_for_text",
  "wait_for_selector",
  "wait_for_network_idle",
  "wait_for_load",
  "screenshot",
  "list_cookies",
  "get_storage",
])

/** The command one operation travels as on this Host. */
export function browserSocketCommand(operation: string): string {
  return !isTauri() && BROWSER_READ_OPERATIONS.has(operation)
    ? "companion_browser_extension_read"
    : "companion_browser_extension_call"
}

/** Run one operation in a paired browser; its refusal keeps the socket's code. */
export function callBrowserSocket(input: BrowserSocketCall): Promise<unknown> {
  return browserSocketTransport().call<unknown>(browserSocketCommand(input.operation), {
    deviceId: input.deviceId,
    operation: input.operation,
    args: input.args,
    timeoutMs: input.timeoutMs,
  })
}
