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

import type { TerminalErrorCode } from "./protocol"
import type {
  IntegrationEvent,
  SessionInfo,
  TerminalControlState,
  TerminalReplayGap,
} from "./types"

export type DataListener = (bytes: Uint8Array) => void
export type IntegrationListener = (event: IntegrationEvent) => void
export type ExitListener = (code: number | null) => void
export type ControlStateListener = (state: TerminalControlState) => void
export type ReplayGapListener = (gap: TerminalReplayGap) => void

export class TerminalSessionError extends Error {
  constructor(
    readonly code: TerminalErrorCode,
    message: string
  ) {
    super(message)
    this.name = "TerminalSessionError"
  }
}

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
  protected readonly controlStateListeners = new Set<ControlStateListener>()
  protected readonly replayGapListeners = new Set<ReplayGapListener>()
  protected exited = false
  protected exitCode: number | null = null
  protected controlState: TerminalControlState = {
    role: "controller",
    controllerId: null,
  }

  // Early-data buffer: bytes that arrive while there is NO data listener are
  // held here and replayed to the next subscriber instead of being dropped.
  // This is what makes a reattached session (webview reload) repaint — Rust
  // replays the retained scrollback the instant the Channel is wired, long
  // before the dock mounts the xterm and calls `onData`. It also restores the
  // last screen when switching back to a background tab (the dock only mounts
  // the active tab's instance). Bounded so a chatty unwatched shell can't grow
  // it without limit — the oldest chunks are dropped, which is harmless since
  // a fresh xterm only renders the latest screen anyway.
  private pendingData: Uint8Array[] = []
  private pendingBytes = 0
  private static readonly MAX_PENDING_BYTES = 1024 * 1024

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
    // Replay anything buffered while no one was listening, in arrival order,
    // so the new subscriber (a freshly-mounted xterm) repaints the screen.
    if (this.pendingData.length > 0) {
      const pending = this.pendingData
      this.pendingData = []
      this.pendingBytes = 0
      for (const chunk of pending) {
        try {
          listener(chunk)
        } catch (err) {
          console.warn(`terminal-session(${this.info.id}): data listener threw on replay:`, err)
        }
      }
    }
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

  onControlState(listener: ControlStateListener): () => void {
    this.controlStateListeners.add(listener)
    queueMicrotask(() => {
      if (this.controlStateListeners.has(listener)) listener(this.controlState)
    })
    return () => {
      this.controlStateListeners.delete(listener)
    }
  }

  onReplayGap(listener: ReplayGapListener): () => void {
    this.replayGapListeners.add(listener)
    return () => {
      this.replayGapListeners.delete(listener)
    }
  }

  // ── Transport surface ────────────────────────────────────────────
  abstract write(data: Uint8Array | string): Promise<void>
  abstract resize(rows: number, cols: number): Promise<void>
  /** Stop viewing this session without terminating its process. */
  abstract detach(): Promise<void>
  /** Acquire the single controller lease after user confirmation. */
  abstract takeControl(): Promise<void>
  /** Voluntarily become read-only while keeping the attachment alive. */
  abstract releaseControl(): Promise<void>
  abstract kill(): Promise<void>

  /**
   * Ask the producer to stop (or resume) sending output.
   *
   * Concrete no-op by default, and deliberately so: transports without
   * end-to-end flow control (LAN/WAN WebSocket, WebRTC, SSH) degrade to
   * renderer-side buffering only — `TerminalBackpressure` still coalesces and
   * holds the output, it simply cannot stop it at the source. The UI says which
   * of the two is happening (`terminal.sessionState.outputThrottled` vs
   * `outputThrottledBuffered`) rather than pretending they are the same.
   *
   * @returns `true` when the transport actually applied the request.
   */
  setFlowControl(_paused: boolean): Promise<boolean> {
    return Promise.resolve(false)
  }

  /** True when {@link setFlowControl} reaches the producer rather than no-opping. */
  get supportsFlowControl(): boolean {
    return false
  }

  // ── Fan-out helpers for subclasses ───────────────────────────────

  protected dispatchData(bytes: Uint8Array): void {
    if (this.dataListeners.size === 0) {
      this.bufferPendingData(bytes)
      return
    }
    for (const listener of this.dataListeners) {
      try {
        listener(bytes)
      } catch (err) {
        console.warn(`terminal-session(${this.info.id}): data listener threw:`, err)
      }
    }
  }

  /** Append to the early-data buffer, dropping oldest chunks past the cap. */
  private bufferPendingData(bytes: Uint8Array): void {
    if (bytes.length === 0) return
    this.pendingData.push(bytes)
    this.pendingBytes += bytes.length
    while (
      this.pendingBytes > BaseTerminalSession.MAX_PENDING_BYTES &&
      this.pendingData.length > 1
    ) {
      const dropped = this.pendingData.shift()
      if (dropped) this.pendingBytes -= dropped.length
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

  protected dispatchControlState(state: TerminalControlState): void {
    this.controlState = state
    for (const listener of this.controlStateListeners) {
      try {
        listener(state)
      } catch (err) {
        console.warn(`terminal-session(${this.info.id}): control listener threw:`, err)
      }
    }
  }

  protected dispatchReplayGap(gap: TerminalReplayGap): void {
    for (const listener of this.replayGapListeners) {
      try {
        listener(gap)
      } catch (err) {
        console.warn(`terminal-session(${this.info.id}): replay-gap listener threw:`, err)
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
