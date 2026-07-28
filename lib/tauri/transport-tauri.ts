"use client"

import { invoke } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import { createDiagnostic } from "@cognia/diagnostics"
import type { Transport } from "./transport-types"
import { safeUnlisten } from "./safe-unlisten"
import { dispatchDiagnostic } from "@/lib/diagnostics/bus"

/**
 * Production transport for desktop Tauri mode.
 *
 * `call()` is a thin pass-through to `@tauri-apps/api/core` `invoke`.
 *
 * `subscribe()` bridges Tauri's async-listen API into the synchronous
 * unsubscribe contract our `Transport` interface promises. The listen Promise
 * resolves in the background; if the caller unsubscribes before it does,
 * `cancelled` flips and the unlisten fires the moment listen completes.
 *
 * A listen() rejection still cannot be thrown — surfacing it inside an effect
 * would crash the React tree, and the caller has no useful way to react. But it
 * used to be swallowed *entirely*, which is worse than it sounds: every
 * subscription on that channel simply stops updating, so the surfaces fed by it
 * freeze with no error, no log line, and no hint that a reload would fix it.
 * The rejection now raises an `eventChannelLost` diagnostic — logged
 * unconditionally, and filed to the notification center where it is at least
 * discoverable.
 */
export class TauriTransport implements Transport {
  call<T = unknown>(name: string, args?: Record<string, unknown>): Promise<T> {
    return invoke<T>(name, args)
  }

  subscribe<T = unknown>(event: string, handler: (payload: T) => void): () => void {
    let cancelled = false
    let unlisten: UnlistenFn | null = null

    listen<T>(event, (e) => handler(e.payload)).then(
      (fn) => {
        if (cancelled) {
          safeUnlisten(fn)
        } else {
          unlisten = fn
        }
      },
      (err: unknown) => {
        // listen rejected — Tauri unavailable. Mark cancelled so a subsequent
        // unsubscribe call is a no-op rather than calling a null unlisten.
        cancelled = true
        // Deduped per event name by the notifier, so a boot that registers
        // twenty dead subscriptions produces one counted row, not twenty.
        dispatchDiagnostic(
          createDiagnostic("eventChannelLost", {
            source: "tauri",
            message: err instanceof Error ? err.message : String(err),
            meta: { extra: { event } },
          })
        )
      }
    )

    return () => {
      cancelled = true
      if (unlisten) {
        const fn = unlisten
        unlisten = null
        safeUnlisten(fn)
      }
    }
  }
}
