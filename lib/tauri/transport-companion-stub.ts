"use client"

import type { Transport } from "./transport-types"

/**
 * Placeholder transport for Capacitor mobile mode.
 *
 * Lives in its own class — separate from `WebStubTransport` — so M2 fills
 * in real HTTP/WS calls only on this branch. Failures here surface as
 * "companion transport not implemented yet" so a developer running in a
 * Capacitor shell against a not-yet-built API surface gets a precise
 * diagnostic rather than the generic web-mode error.
 *
 * Replaced by `CompanionTransport` (real HTTP + WS impl) in M2.7.
 */
export class CompanionTransportStub implements Transport {
  call<T = unknown>(name: string, _args?: Record<string, unknown>): Promise<T> {
    return Promise.reject<T>(
      new Error(
        `companion transport not implemented yet — see M2: device-JWT pairing (called: ${name})`
      )
    )
  }

  subscribe<T = unknown>(_event: string, _handler: (payload: T) => void): () => void {
    return () => {}
  }
}
