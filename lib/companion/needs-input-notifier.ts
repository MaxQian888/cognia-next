"use client"

/**
 * Remote Session Control — decision-point notifier.
 *
 * When a host session that a remote device is watching hits a tool-use
 * approval (and the desktop routed it to that device instead of auto-denying —
 * see `hooks/chat/use-claude-chat.ts`), the remote may have backgrounded the
 * app, dropping its `/ws/events` subscription. This emits a dedicated
 * `companion://needs-input` Tauri event that the Rust `register_push_trigger`
 * (in `companion_api/commands.rs`) fans out as an APNs/FCM push to every
 * offline paired device — so the approval doesn't silently wait out its
 * backstop timeout.
 *
 * Lazy Tauri import so the web/mobile bundle stays decoupled; failures are
 * swallowed (the approval is still pending and recoverable when the device
 * reopens its `/ws/events` stream).
 */

import { isTauri } from "@/lib/platform/detect"

export interface NeedsInputPayload {
  sessionId: string
  requestId: string
  toolName: string
}

export async function notifyRemoteNeedsInput(payload: NeedsInputPayload): Promise<void> {
  if (!isTauri()) return
  try {
    const moduleId = "@tauri-apps/api/event"
    const mod = (await import(/* webpackIgnore: true */ moduleId)) as {
      emit: (event: string, payload: unknown) => Promise<void>
    }
    await mod.emit("companion://needs-input", payload)
  } catch {
    // Tauri unavailable or transport hiccup — best effort.
  }
}
