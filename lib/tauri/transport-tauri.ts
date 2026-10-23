"use client"

import { invoke } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import { createDiagnostic } from "@cognia/diagnostics"
import type { Transport, TransportCallOptions } from "./transport-types"
import { localInvocation } from "./local-environment-commands"
import { safeUnlisten } from "./safe-unlisten"
import { dispatchDiagnostic } from "@/lib/diagnostics/bus"

/**
 * Production transport for desktop Tauri mode.
 *
 * `call()` is a thin pass-through to `@tauri-apps/api/core` `invoke`, except
 * for the runtime-environment commands, which a desktop answers through one
 * local dispatcher (see `./local-environment-commands`).
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
  private readonly pendingSubscriptions = new Map<string, Set<Promise<void>>>()

  constructor(private readonly listenEvent: typeof listen = listen) {}

  async whenSubscribed(channels: readonly string[], timeoutMs?: number): Promise<void> {
    const pending = channels.flatMap((channel) => [
      ...(this.pendingSubscriptions.get(channel) ?? []),
    ])
    const ready = Promise.all(pending)
    if (timeoutMs === undefined) {
      await ready
      return
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        ready,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, Math.max(0, timeoutMs))
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  call<T = unknown>(
    name: string,
    args?: Record<string, unknown>,
    _options?: TransportCallOptions
  ): Promise<T> {
    const local = localInvocation(name, args)
    if (
      name.startsWith("desktop_") ||
      name.startsWith("record_") ||
      name === "automation_execute"
    ) {
      // The SDK retains options when retrying custom-protocol IPC through
      // postMessage. A new API call gets a new id even for identical actions.
      return invoke<T>(local.command, local.args, {
        headers: { "x-cognia-automation-invocation": crypto.randomUUID() },
      })
    }
    return invoke<T>(local.command, local.args)
  }

  subscribe<T = unknown>(event: string, handler: (payload: T) => void): () => void {
    let cancelled = false
    let unlisten: UnlistenFn | null = null
    let resolveReady!: () => void
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve
    })
    const pending = this.pendingSubscriptions.get(event) ?? new Set<Promise<void>>()
    pending.add(ready)
    this.pendingSubscriptions.set(event, pending)
    let finished = false
    const finishReady = () => {
      if (finished) return
      finished = true
      pending.delete(ready)
      if (pending.size === 0) this.pendingSubscriptions.delete(event)
      resolveReady()
    }

    this.listenEvent<T>(event, (e) => handler(e.payload)).then(
      (fn) => {
        if (cancelled) {
          safeUnlisten(fn)
        } else {
          unlisten = fn
        }
        finishReady()
      },
      (err: unknown) => {
        // listen rejected — Tauri unavailable. Mark cancelled so a subsequent
        // unsubscribe call is a no-op rather than calling a null unlisten.
        cancelled = true
        finishReady()
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
      finishReady()
      if (unlisten) {
        const fn = unlisten
        unlisten = null
        safeUnlisten(fn)
      }
    }
  }
}
