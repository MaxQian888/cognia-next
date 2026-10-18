/**
 * The desktop app's `remote-console` child webview (ADR-0234 Phase 5,
 * `src-tauri/src/browser/remote_console.rs`): one native webview pinned over
 * the viewer page's reserved box, holding the user's own web console.
 *
 * Calls are serialized so a bounds update can never reach the native side
 * before the open it belongs to, and a close always comes last.
 */

import type { ElementRect } from "@/lib/browser/protocol"
import { localTransport } from "@/lib/tauri/transport-instance"
import type { Transport } from "@/lib/tauri/transport-types"

import { isOpenableConsoleUrl } from "./launch"
import { RemoteDesktopError } from "./host-client"

type Caller = Pick<Transport, "call">

let caller: Caller = localTransport
let queue: Promise<unknown> = Promise.resolve()

/** Test seam. */
export function __setConsoleWebviewCallerForTests(next?: Caller): void {
  caller = next ?? localTransport
  queue = Promise.resolve()
}

function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work)
  queue = next.catch(() => undefined)
  return next
}

export function openConsoleWebview(url: string, rect: ElementRect): Promise<void> {
  if (!isOpenableConsoleUrl(url)) {
    return Promise.reject(new RemoteDesktopError("remote_desktop_console_url_invalid"))
  }
  return enqueue(() => caller.call<void>("remote_console_open", { url, ...rect }))
}

export function setConsoleWebviewBounds(rect: ElementRect): Promise<void> {
  return enqueue(() => caller.call<void>("remote_console_set_bounds", { ...rect }))
}

/** Hidden parks the webview off-screen: CSS cannot clip a native layer. */
export function setConsoleWebviewVisible(visible: boolean, rect: ElementRect): Promise<void> {
  return enqueue(() => caller.call<void>("remote_console_set_visible", { visible, ...rect }))
}

export function reloadConsoleWebview(): Promise<void> {
  return enqueue(() => caller.call<void>("remote_console_reload", {}))
}

export function closeConsoleWebview(): Promise<void> {
  return enqueue(() => caller.call<void>("remote_console_close", {}))
}
