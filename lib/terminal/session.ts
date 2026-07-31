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

export class TerminalSession extends BaseTerminalSession {
  readonly info: SessionInfo

  private readonly channel: Channel<SeqEvent>
  private lastSeqValue = 0

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

  async kill(): Promise<void> {
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
