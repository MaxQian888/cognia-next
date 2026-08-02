"use client"

/**
 * `TerminalSession` — TypeScript handle on a Rust-side `PtySession`.
 *
 * Spawns through `terminal_spawn`, holds a `Channel<TerminalEvent>` that
 * the Rust reader/waiter threads send into, fans events out to typed
 * subscriber lists (inherited from `BaseTerminalSession`), and offers
 * `write` / `resize` / `kill` as thin `invoke` wrappers.
 *
 * This file is the SOLE consumer of the `terminal_*` Tauri commands —
 * never call them directly from components. UI subscribes to instances
 * of this class through `terminal-store`.
 */

import { Channel, invoke } from "@tauri-apps/api/core"

import { BaseTerminalSession } from "./base-session"
import type { SessionInfo, SpawnRequest, TerminalEvent } from "./types"

interface SpawnResult {
  session: SessionInfo
}

/**
 * Wire envelope from the Rust desktop Channel (1C). The `seq` lets the
 * renderer resume via `terminal_reattach` after a reload; `event` is the
 * payload the base class fans out.
 */
interface SeqEvent {
  seq: number
  event: TerminalEvent
}

/**
 * How often an outstanding flow-control pause is re-asserted to the host.
 *
 * Must stay comfortably below the host's `FLOW_PAUSE_MAX` (30 s, see
 * `crates/cognia-terminal/src/host.rs`) so a couple of missed ticks — a busy
 * main thread, a slow IPC round trip — still cannot let the lease lapse under a
 * client that is genuinely still throttled.
 */
export const FLOW_PAUSE_RENEW_MS = 10_000

export class TerminalSession extends BaseTerminalSession {
  readonly info: SessionInfo

  private readonly channel: Channel<SeqEvent>
  private lastSeqValue = 0
  /** Latched once the host has rejected `terminal_set_flow_control`. */
  private flowControlUnsupported = false
  /** Timer renewing an outstanding pause; see {@link FLOW_PAUSE_RENEW_MS}. */
  private flowRenewTimer: ReturnType<typeof setInterval> | null = null

  private constructor(info: SessionInfo, channel: Channel<SeqEvent>) {
    super()
    this.info = info
    this.channel = channel
    this.channel.onmessage = (msg) => {
      this.lastSeqValue = msg.seq
      this.dispatch(msg.event)
    }
  }

  /** Highest replay seq received so far — the resume point for `reattach`. */
  get lastSeq(): number {
    return this.lastSeqValue
  }

  static async spawn(req: SpawnRequest): Promise<TerminalSession> {
    const onEvent = new Channel<SeqEvent>()
    // The spawn handler returns immediately after the reader/waiter
    // threads are spawned; the Channel starts receiving inside that call
    // window, so onmessage must be wired before we await — but we wire
    // it after the await because the Rust Channel buffers events until
    // a handler is set. (See `tauri::ipc::Channel` docs.)
    const result = await invoke<SpawnResult>("terminal_spawn", {
      req,
      profileId: req.profileId,
      onEvent,
    })
    return new TerminalSession(result.session, onEvent)
  }

  /**
   * Reattach to a session that survived a webview reload (1C). The Rust
   * process kept the PTY alive; this rewires a fresh Channel and replays
   * events with `seq > resumeFrom`. `resumeFrom = 0` replays the whole
   * retained buffer, restoring recent scrollback into the fresh xterm.
   */
  static async reattach(sessionId: string, resumeFrom = 0): Promise<TerminalSession> {
    const onEvent = new Channel<SeqEvent>()
    const info = await invoke<SessionInfo>("terminal_reattach", {
      id: sessionId,
      onEvent,
      resumeFrom,
    })
    const session = new TerminalSession(info, onEvent)
    session.lastSeqValue = resumeFrom
    return session
  }

  async write(data: Uint8Array | string): Promise<void> {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data
    await invoke<void>("terminal_write", {
      id: this.info.id,
      data: Array.from(bytes),
    })
  }

  async resize(rows: number, cols: number): Promise<void> {
    await invoke<void>("terminal_resize", {
      id: this.info.id,
      rows: Math.max(1, Math.floor(rows)),
      cols: Math.max(1, Math.floor(cols)),
    })
  }

  async detach(): Promise<void> {
    // Detaching drops the host-side claim with the attachment, so renewing it
    // afterwards would only log failures.
    this.stopFlowRenewal()
    await invoke<void>("terminal_detach", { id: this.info.id })
  }

  async takeControl(): Promise<void> {
    await invoke<void>("terminal_take_control", { id: this.info.id })
    this.dispatchControlState({ role: "controller", controllerId: "local" })
  }

  async releaseControl(): Promise<void> {
    await invoke<void>("terminal_release_control", { id: this.info.id })
    this.dispatchControlState({ role: "viewer", controllerId: null, reason: "released" })
  }

  /**
   * The only transport with real flow control today: the host parks the PTY's
   * reader thread, so unread bytes stay in the kernel buffer and the child
   * blocks on write. Nothing is dropped and nothing accumulates in user space.
   *
   * A pause is a *lease*, not a latch: `TerminalHost::reap_flow_pauses` drops
   * any claim older than `FLOW_PAUSE_MAX` (30 s) so a wedged client cannot park
   * someone's PTY forever. The renderer only reports the false→true watermark
   * crossing once, so without renewal a genuinely slow consumer would be
   * force-resumed mid-flood and never re-pause. Renewing on a timer keeps the
   * backstop aimed at clients that actually stopped running.
   */
  override async setFlowControl(paused: boolean): Promise<boolean> {
    if (this.flowControlUnsupported) return false
    const applied = await this.sendFlowControl(paused)
    if (!applied) {
      this.stopFlowRenewal()
      return false
    }
    if (paused) this.startFlowRenewal()
    else this.stopFlowRenewal()
    return true
  }

  private async sendFlowControl(paused: boolean): Promise<boolean> {
    try {
      await invoke<void>("terminal_set_flow_control", { id: this.info.id, paused })
      return true
    } catch {
      // An older durable host (a login service installed before this build)
      // rejects the command. Latch it off rather than re-issuing an IPC call
      // on every watermark crossing.
      this.flowControlUnsupported = true
      return false
    }
  }

  private startFlowRenewal(): void {
    if (this.flowRenewTimer) return
    this.flowRenewTimer = setInterval(() => {
      if (this.isExited || this.flowControlUnsupported) {
        this.stopFlowRenewal()
        return
      }
      void this.sendFlowControl(true)
    }, FLOW_PAUSE_RENEW_MS)
  }

  private stopFlowRenewal(): void {
    if (!this.flowRenewTimer) return
    clearInterval(this.flowRenewTimer)
    this.flowRenewTimer = null
  }

  override get supportsFlowControl(): boolean {
    return !this.flowControlUnsupported
  }

  async kill(): Promise<void> {
    this.stopFlowRenewal()
    if (this.isExited) return
    await invoke<void>("terminal_kill", { id: this.info.id })
  }

  private dispatch(event: TerminalEvent): void {
    switch (event.kind) {
      case "data": {
        this.dispatchData(new Uint8Array(event.bytes))
        break
      }
      case "integration": {
        this.dispatchIntegration(event.event)
        break
      }
      case "exit": {
        // The session is gone; there is no lease left to renew.
        this.stopFlowRenewal()
        this.handleExit(event.code ?? null)
        break
      }
      case "replay_gap": {
        this.dispatchReplayGap({
          requestedAfter: event.requested_after,
          firstAvailable: event.first_available,
          lastAvailable: event.last_available,
        })
        break
      }
      case "controller_changed": {
        this.dispatchControlState({
          role: event.controller === "desktop" ? "controller" : "viewer",
          controllerId: event.controller,
          reason: event.controller === "desktop" ? undefined : "takeover",
        })
        break
      }
    }
  }
}

export async function listTerminalsForProject(projectId: string): Promise<SessionInfo[]> {
  return invoke<SessionInfo[]>("terminal_list_for_project", { projectId })
}

export async function listAllTerminals(): Promise<SessionInfo[]> {
  return invoke<SessionInfo[]>("terminal_list_all")
}
