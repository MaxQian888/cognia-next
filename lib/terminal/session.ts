"use client"

/**
 * `TerminalSession` — TypeScript handle on a Rust-side `PtySession`.
 *
 * Spawns through `terminal_spawn`, holds a `Channel<TerminalEvent>` that
 * the Rust reader/waiter threads send into, fans events out to typed
 * subscriber lists, and offers `write` / `resize` / `kill` as thin
 * `invoke` wrappers.
 *
 * This file is the SOLE consumer of the `terminal_*` Tauri commands —
 * never call them directly from components. UI subscribes to instances
 * of this class through `terminal-store`.
 */

import { Channel, invoke } from "@tauri-apps/api/core"

import type { IntegrationEvent, SessionInfo, SpawnRequest, TerminalEvent } from "./types"

interface SpawnResult {
  session: SessionInfo
}

type DataListener = (bytes: Uint8Array) => void
type IntegrationListener = (event: IntegrationEvent) => void
type ExitListener = (code: number | null) => void

export class TerminalSession {
  readonly info: SessionInfo

  private readonly channel: Channel<TerminalEvent>
  private readonly dataListeners = new Set<DataListener>()
  private readonly integrationListeners = new Set<IntegrationListener>()
  private readonly exitListeners = new Set<ExitListener>()
  private exited = false
  private exitCode: number | null = null

  private constructor(info: SessionInfo, channel: Channel<TerminalEvent>) {
    this.info = info
    this.channel = channel
    this.channel.onmessage = (event) => this.dispatch(event)
  }

  get id(): string {
    return this.info.id
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
    if (this.exited) return
    await invoke<void>("terminal_kill", { id: this.info.id })
  }

  /** True once an `exit` event has been observed. */
  get isExited(): boolean {
    return this.exited
  }

  /** Exit code, or `null` if the process was killed by signal / not yet exited. */
  get lastExitCode(): number | null {
    return this.exitCode
  }

  onData(listener: DataListener): () => void {
    this.dataListeners.add(listener)
    return () => this.dataListeners.delete(listener)
  }

  onIntegration(listener: IntegrationListener): () => void {
    this.integrationListeners.add(listener)
    return () => this.integrationListeners.delete(listener)
  }

  onExit(listener: ExitListener): () => void {
    // If the session already exited, fire immediately on next microtask so
    // late subscribers can clean up without missing the event.
    if (this.exited) {
      queueMicrotask(() => listener(this.exitCode))
      return () => undefined
    }
    this.exitListeners.add(listener)
    return () => this.exitListeners.delete(listener)
  }

  private dispatch(event: TerminalEvent): void {
    switch (event.kind) {
      case "data": {
        const buf = new Uint8Array(event.bytes)
        for (const listener of this.dataListeners) {
          try {
            listener(buf)
          } catch (err) {
            console.warn(`terminal-session(${this.info.id}): data listener threw:`, err)
          }
        }
        break
      }
      case "integration": {
        for (const listener of this.integrationListeners) {
          try {
            listener(event.event)
          } catch (err) {
            console.warn(`terminal-session(${this.info.id}): integration listener threw:`, err)
          }
        }
        break
      }
      case "exit": {
        this.exited = true
        this.exitCode = event.code ?? null
        for (const listener of this.exitListeners) {
          try {
            listener(this.exitCode)
          } catch (err) {
            console.warn(`terminal-session(${this.info.id}): exit listener threw:`, err)
          }
        }
        this.exitListeners.clear()
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
