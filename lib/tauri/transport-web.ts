"use client"

import type { Transport, TransportCallOptions } from "./transport-types"

/**
 * Transport used in plain-browser mode (no Tauri, no Capacitor).
 *
 * `call()` rejects with a clear error so callers degrade gracefully — this
 * mirrors the behavior pre-refactor, where calling `invoke` outside Tauri
 * threw because `__TAURI_INTERNALS__` was missing on `window`.
 *
 * `subscribe()` is a no-op so React effects can register handlers without
 * runtime errors; the returned unsubscribe is a no-op too and safe to call
 * multiple times.
 */
export class WebStubTransport implements Transport {
  call<T = unknown>(
    name: string,
    _args?: Record<string, unknown>,
    _options?: TransportCallOptions
  ): Promise<T> {
    return Promise.reject<T>(new Error(`tauri-only command from web mode: ${name}`))
  }

  subscribe<T = unknown>(_event: string, _handler: (payload: T) => void): () => void {
    return () => {}
  }
}
