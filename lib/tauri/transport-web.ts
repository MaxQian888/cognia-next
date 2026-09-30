"use client"

import type { Transport, TransportCallOptions } from "./transport-types"

/**
 * Transport used in plain-browser mode (no Tauri, no Capacitor).
 *
 * `call()` rejects with a clear error so callers degrade gracefully — this
 * mirrors the behavior pre-refactor, where calling `invoke` outside Tauri
 * threw because `__TAURI_INTERNALS__` was missing on `window`.
 *
 * The rejection carries `code: "no_host_transport"` so callers that need to
 * tell "nothing here can answer" apart from "the host answered with an error"
 * (the sync orchestrator, which must not paint a table red for it) can do so
 * without matching the message text.
 *
 * `subscribe()` is a no-op so React effects can register handlers without
 * runtime errors; the returned unsubscribe is a no-op too and safe to call
 * multiple times.
 */
export const NO_HOST_TRANSPORT_CODE = "no_host_transport"

export class WebStubTransport implements Transport {
  call<T = unknown>(
    name: string,
    _args?: Record<string, unknown>,
    _options?: TransportCallOptions
  ): Promise<T> {
    const error = Object.assign(new Error(`tauri-only command from web mode: ${name}`), {
      code: NO_HOST_TRANSPORT_CODE,
    })
    return Promise.reject<T>(error)
  }

  subscribe<T = unknown>(_event: string, _handler: (payload: T) => void): () => void {
    return () => {}
  }
}
