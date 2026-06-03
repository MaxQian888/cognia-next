// Bridge: Tauri "a2ui://dispatch" events → useA2UIStore.
//
// The sidecar (or stand-alone a2ui-mcp.mjs) emits one JSON line per a2ui
// protocol message. Tauri forwards them on the dedicated `a2ui://dispatch`
// event channel; this module subscribes once at app startup and dispatches
// the embedded `message` straight into the store.

import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import { isTauri } from "@/lib/tauri"
import { useA2UIStore } from "@/stores/a2ui"
import type { A2UIDispatchMessage } from "@/types/a2ui/schema"
import { loggers } from "@/lib/logging"

const A2UI_EVENT = "a2ui://dispatch"

export interface A2UIDispatchEnvelope {
  type: "a2ui_dispatch"
  sessionId?: string
  message: A2UIDispatchMessage
}

/**
 * Subscribe to a2ui dispatch events. Returns an unlisten function. No-op
 * outside Tauri (web mode), where dispatches arrive purely through chat
 * codeblock detection / parser-driven flows.
 */
export async function subscribeA2UIDispatch(): Promise<UnlistenFn> {
  if (!isTauri()) {
    return () => {}
  }
  return listen<A2UIDispatchEnvelope>(A2UI_EVENT, (event) => {
    const payload = event.payload
    if (!payload || payload.type !== "a2ui_dispatch" || !payload.message) {
      loggers.app.warn("a2ui dispatch payload shape unexpected", { payload })
      return
    }
    try {
      useA2UIStore.getState().processMessage(payload.message)
    } catch (err) {
      loggers.app.error("a2ui dispatch processing failed", { error: String(err) })
    }
  })
}
