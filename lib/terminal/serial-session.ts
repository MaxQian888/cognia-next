"use client"

/**
 * A serial port, rendered as a terminal session.
 *
 * The dock, the tab strip, xterm, search, the AI-shell context reader and the
 * split panes all bind to `BaseTerminalSession`, so implementing that contract
 * is what makes a serial monitor exist at all rather than being a second panel
 * with its own scrollback, its own search box and its own copy behaviour. A
 * serial port IS a byte stream in both directions, which is the entire surface
 * the base class asks for.
 *
 * Three of the base contract's ideas do not apply, and the implementations say
 * so rather than pretending:
 *
 *  - **resize** is a no-op. A serial line has no window size to report. xterm
 *    still reflows locally, which is the behaviour a monitor wants.
 *  - **exit** has no code. The port closing is not a process ending, so
 *    `handleExit(null)` is the truthful call, and the `null` reads through the
 *    dock as "no exit code" exactly as it does for a signalled shell.
 *  - **integration** events never arrive. OSC 633 comes from a shell
 *    integration script that a device on the other end of a cable has not
 *    sourced.
 *
 * Inbound bytes arrive base64-encoded on `terminal://serial/<id>/data`, which
 * is what `crates/cognia-terminal/src/serial.rs` publishes. Base64 rather than
 * a JSON number array because the latter is roughly a 4x expansion and a
 * 115200-baud device saturates it.
 */

import { listen, type UnlistenFn } from "@tauri-apps/api/event"

import { BaseTerminalSession } from "./base-session"
import {
  closeSerialPort,
  formatSerialConfig,
  openSerialPort,
  writeSerialPort,
} from "./serial/serial-connection"
import type { SerialConfig, SerialConnectionStatus } from "./serial/types"
import type { SessionInfo } from "./types"

/** Payload of `terminal://serial/<id>/data`. */
interface SerialDataEvent {
  base64: string
}

/** Payload of `terminal://serial/<id>/status`. */
interface SerialStatusEvent {
  status: SerialConnectionStatus
  reason?: string
}

export function serialDataTopic(sessionId: string): string {
  return `terminal://serial/${sessionId}/data`
}

export function serialStatusTopic(sessionId: string): string {
  return `terminal://serial/${sessionId}/status`
}

/** base64 → bytes, without pulling a dependency for eleven lines. */
export function decodeBase64(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

export class SerialTerminalSession extends BaseTerminalSession {
  readonly info: SessionInfo
  readonly config: SerialConfig
  private status: SerialConnectionStatus = "connected"
  private unlisten: UnlistenFn[] = []

  private constructor(sessionId: string, config: SerialConfig, projectId: string | null) {
    super()
    this.config = config
    this.info = {
      id: sessionId,
      projectId,
      extensionId: null,
      origin: "user",
      // The tab label and every "where am I" readout come from `shell`. A port
      // path plus its line settings is the honest answer to that question for
      // a serial session, and it is the same string the picker showed.
      shell: `${config.port} (${formatSerialConfig(config)})`,
      alive: true,
      kind: "serial",
      createdAt: Date.now(),
    }
  }

  /**
   * Open `config.port` and start streaming.
   *
   * Listeners are attached BEFORE the first byte can arrive, because the base
   * class's early-data buffer only covers the window between the first byte
   * and the first subscriber. A device that greets on open (most bootloaders
   * do) would otherwise lose its banner.
   */
  static async open(config: SerialConfig, projectId: string | null = null) {
    const result = await openSerialPort(config)
    if ("error" in result) throw new Error(result.error)
    const session = new SerialTerminalSession(result.sessionId, config, projectId)
    await session.subscribe()
    return session
  }

  private async subscribe(): Promise<void> {
    const data = await listen<SerialDataEvent>(serialDataTopic(this.info.id), (event) => {
      this.dispatchData(decodeBase64(event.payload.base64))
    })
    const status = await listen<SerialStatusEvent>(serialStatusTopic(this.info.id), (event) => {
      this.status = event.payload.status
      if (event.payload.status !== "error") return
      // A cable pulled mid-transfer is the one status a monitor must show in
      // the stream itself: the scrollback above it is real data, and without a
      // marker the user cannot tell where the device stopped answering.
      const reason = event.payload.reason ?? "the serial connection failed"
      this.dispatchData(new TextEncoder().encode(`\r\n[31m[serial] ${reason}[0m\r\n`))
      this.teardown()
      this.handleExit(null)
    })
    this.unlisten = [data, status]
  }

  private teardown(): void {
    for (const off of this.unlisten) off()
    this.unlisten = []
  }

  /** Live connection state, for a status chip. */
  get connectionStatus(): SerialConnectionStatus {
    return this.status
  }

  async write(data: string): Promise<void> {
    // The line ending is already appended by whoever composed `data`, so this
    // passes bytes through. `writeSerialPort`'s own `lineEnding` parameter is
    // for the composer, not for keystrokes.
    const ok = await writeSerialPort(this.info.id, data)
    if (!ok) throw new Error("the serial port did not accept the write")
  }

  async resize(): Promise<void> {
    // A serial line has no window size. xterm reflows on its own, and there is
    // nothing to tell the device.
  }

  async kill(): Promise<void> {
    this.teardown()
    await closeSerialPort(this.info.id)
    this.status = "disconnected"
    this.handleExit(null)
  }
}
