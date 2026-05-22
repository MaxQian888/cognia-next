"use client"

/**
 * Shared listener / exit-state plumbing for every terminal transport.
 *
 * Before Wave 2 the listener fan-out + exit bookkeeping lived inline in
 * both `lib/terminal/session.ts` (Tauri Channel) and
 * `lib/terminal/transport-ws.ts` (LAN WebSocket). The two copies were
 * ~80 LOC of byte-for-byte duplication. Adding `transport-webrtc.ts`
 * would have made it three. This base class collapses them into one
 * surface so each transport only owns its connection lifecycle and the
 * adapter that converts wire frames to typed `dispatch*` calls.
 *
 * Subclass contract:
 *   * Implement `write`, `resize`, `kill` against the transport.
 *   * Call `dispatchData(bytes)` / `dispatchIntegration(event)` from
 *     the wire-decode loop.
 *   * Call `handleExit(code)` exactly once when the underlying
 *     connection closes (clean exit or transport failure).
 */

import type { IntegrationEvent, SessionInfo } from "./types"

export type DataListener = (bytes: Uint8Array) => void
export type IntegrationListener = (event: IntegrationEvent) => void
export type ExitListener = (code: number | null) => void

/**
 * Abstract base for every `*TerminalSession` class.
 *
 * Subclasses must expose `info`, implement the three transport
 * primitives, and drive the protected `dispatch*` / `handleExit`
 * helpers from their own decoders.
 */
export abstract class BaseTerminalSession {
  abstract readonly info: SessionInfo

  protected readonly dataListeners = new Set<DataListener>()
  protected readonly integrationListeners = new Set<IntegrationListener>()
  protected readonly exitListeners = new Set<ExitListener>()
  protected exited = false
  protected exitCode: number | null = null

  /** Stable session id from the info block. */
  get id(): string {
    return this.info.id
  }

  /** True once an `exit` event has been observed. */
  get isExited(): boolean {
    return this.exited
  }

  /** Exit code, or `null` if the process was killed by signal / not yet exited. */
  get lastExitCode(): number | null {
    return this.exitCode
  }

  // ── Subscriber API ────────────────────────────────────────────────

  onData(listener: DataListener): () => void {
    this.dataListeners.add(listener)
    return () => {
      this.dataListeners.delete(listener)
    }
  }

  onIntegration(listener: IntegrationListener): () => void {
    this.integrationListeners.add(listener)
    return () => {
      this.integrationListeners.delete(listener)
    }
  }

  onExit(listener: ExitListener): () => void {
    // Late subscriber after exit — fire on next microtask so the
    // caller can `await` without missing the event.
    if (this.exited) {
      queueMicrotask(() => listener(this.exitCode))
      return () => undefined
    }
    this.exitListeners.add(listener)
    return () => {
      this.exitListeners.delete(listener)
    }
  }

  // ── Transport surface ────────────────────────────────────────────
  abstract write(data: Uint8Array | string): Promise<void>
  abstract resize(rows: number, cols: number): Promise<void>
  abstract kill(): Promise<void>

  // ── Fan-out helpers for subclasses ───────────────────────────────

  protected dispatchData(bytes: Uint8Array): void {
    for (const listener of this.dataListeners) {
      try {
        listener(bytes)
      } catch (err) {
        console.warn(`terminal-session(${this.info.id}): data listener threw:`, err)
      }
    }
  }

  protected dispatchIntegration(event: IntegrationEvent): void {
    for (const listener of this.integrationListeners) {
      try {
        listener(event)
      } catch (err) {
        console.warn(`terminal-session(${this.info.id}): integration listener threw:`, err)
      }
    }
  }

  /**
   * Mark the session exited and drain the exit listeners. Idempotent —
   * subsequent calls are silently ignored. Subclasses MUST funnel every
   * close (clean exit, transport drop, kill) through this so listeners
   * fire exactly once.
   */
  protected handleExit(code: number | null): void {
    if (this.exited) return
    this.exited = true
    this.exitCode = code
    for (const listener of this.exitListeners) {
      try {
        listener(code)
      } catch (err) {
        console.warn(`terminal-session(${this.info.id}): exit listener threw:`, err)
      }
    }
    this.exitListeners.clear()
  }
}
