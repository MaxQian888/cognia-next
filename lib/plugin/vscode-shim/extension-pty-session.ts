"use client"

/**
 * A VS Code extension's `Pseudoterminal`, rendered as a dock terminal session.
 *
 * Like a serial port (`lib/terminal/serial-session.ts`), it is a byte stream
 * both ways and nothing more, so implementing `BaseTerminalSession` is what
 * gives it a tab, xterm, search and splits. No process runs: what the
 * extension writes arrives through `push`, and what the user types and the
 * tab's size go back to it through the callbacks.
 *
 * Of the base contract, controller leases do not apply (nobody else attaches
 * to this session), and an exit has the code the extension gave, or none.
 */

import { nanoid } from "nanoid"

import { BaseTerminalSession } from "@/lib/terminal/base-session"
import type { SessionInfo } from "@/lib/terminal/types"

export interface ExtensionPtyCallbacks {
  /** The user typed into the tab. */
  onInput(data: string): void
  /** The tab's size changed. */
  onResize(columns: number, rows: number): void
  /** The dock closed the tab (the user, or the app); the extension did not end it. */
  onKill(): void
}

export class ExtensionPtySession extends BaseTerminalSession {
  readonly info: SessionInfo
  private readonly encoder = new TextEncoder()
  private readonly decoder = new TextDecoder()
  private size: { columns: number; rows: number } | null = null

  constructor(
    input: { extensionId: string; name: string; projectId: string | null },
    private readonly callbacks: ExtensionPtyCallbacks
  ) {
    super()
    this.info = {
      id: `vscode-pty-${nanoid()}`,
      projectId: input.projectId,
      extensionId: input.extensionId,
      origin: "local",
      // The tab label reads `shell`; for an extension terminal its name is the honest answer.
      shell: input.name,
      alive: true,
      kind: "extension",
      createdAt: Date.now(),
    }
  }

  /** The extension wrote this. */
  push(data: string): void {
    if (this.exited || data.length === 0) return
    this.dispatchData(this.encoder.encode(data))
  }

  /** The extension ended the terminal. */
  finish(code: number | null): void {
    if (this.exited) return
    this.info.alive = false
    this.handleExit(code)
  }

  async write(data: Uint8Array | string): Promise<void> {
    if (this.exited) return
    const text = typeof data === "string" ? data : this.decoder.decode(data)
    if (text.length > 0) this.callbacks.onInput(text)
  }

  async resize(rows: number, cols: number): Promise<void> {
    if (this.exited) return
    if (this.size?.columns === cols && this.size.rows === rows) return
    this.size = { columns: cols, rows }
    this.callbacks.onResize(cols, rows)
  }

  async detach(): Promise<void> {
    // Nothing outlives the tab: closing the view ends the terminal.
    await this.kill()
  }

  async takeControl(): Promise<void> {
    throw new Error("Extension terminals do not support controller leases")
  }

  async releaseControl(): Promise<void> {
    throw new Error("Extension terminals do not support controller leases")
  }

  async kill(): Promise<void> {
    if (this.exited) return
    this.info.alive = false
    this.callbacks.onKill()
    this.handleExit(null)
  }
}
