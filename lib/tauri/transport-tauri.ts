"use client"

import { invoke } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import type { Transport } from "./transport-types"

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
 * A listen() rejection is swallowed silently — in practice it means the Tauri
 * APIs are unavailable, and surfacing the error inside an effect would crash
 * the React tree without giving the caller a useful signal.
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
          fn()
        } else {
          unlisten = fn
        }
      },
      () => {
        // listen rejected — Tauri unavailable. Mark cancelled so a subsequent
        // unsubscribe call is a no-op rather than calling a null unlisten.
        cancelled = true
      }
    )

    return () => {
      cancelled = true
      if (unlisten) {
        const fn = unlisten
        unlisten = null
        fn()
      }
    }
  }
}
