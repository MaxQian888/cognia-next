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

export class TerminalSession extends BaseTerminalSession {
  readonly info: SessionInfo

  private readonly channel: Channel<TerminalEvent>

  private constructor(info: SessionInfo, channel: Channel<TerminalEvent>) {
    super()
    this.info = info
    this.channel = channel
    this.channel.onmessage = (event) => this.dispatch(event)
  }

  static async spawn(req: SpawnRequest): Promise<TerminalSession> {
    const onEvent = new Channel<TerminalEvent>()
    // The spawn handler returns immediately after the reader/waiter
    // threads are spawned; the Channel starts receiving inside that call
    // window, so onmessage must be wired before we await — but we wire
    // it after the await because the Rust Channel buffers events until
    // a handler is set. (See `tauri::ipc::Channel` docs.)
    const result = await invoke<SpawnResult>("terminal_spawn", {
      req,
      onEvent,
    })
    return new TerminalSession(result.session, onEvent)
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
    }
  }
}

export async function listTerminalsForProject(projectId: string): Promise<SessionInfo[]> {
  return invoke<SessionInfo[]>("terminal_list_for_project", { projectId })
}

export async function listAllTerminals(): Promise<SessionInfo[]> {
  return invoke<SessionInfo[]>("terminal_list_all")
}
