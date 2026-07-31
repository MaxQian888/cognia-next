"use client"

import { decodeTerminalFrame, encodeTerminalFrame, type TerminalFrame } from "./protocol"

export type TerminalHostTransport = "local" | "lan" | "wan" | "memory"
export type TerminalHostConnectionState = "connecting" | "connected" | "reconnecting" | "closed"

export type TerminalFrameListener = (frame: TerminalFrame) => void
export type TerminalConnectionStateListener = (state: TerminalHostConnectionState) => void

export interface TerminalHostConnection {
  readonly transport: TerminalHostTransport
  readonly state: TerminalHostConnectionState
  /** Authenticated host-side client identity, when the adapter knows it. */
  readonly clientId?: string
  /** Optional connection-wide allocator for multiplexed request sequences. */
  nextSequence?(): bigint
  open(): Promise<void>
  send(frame: TerminalFrame): Promise<void>
  onFrame(listener: TerminalFrameListener): () => void
  onState(listener: TerminalConnectionStateListener): () => void
  close(): Promise<void>
}

abstract class BaseHostConnection implements TerminalHostConnection {
  abstract readonly transport: TerminalHostTransport
  private frameListeners = new Set<TerminalFrameListener>()
  private stateListeners = new Set<TerminalConnectionStateListener>()
  protected stateValue: TerminalHostConnectionState = "connecting"

  get state(): TerminalHostConnectionState {
    return this.stateValue
  }

  abstract open(): Promise<void>
  abstract send(frame: TerminalFrame): Promise<void>
  abstract close(): Promise<void>

  onFrame(listener: TerminalFrameListener): () => void {
    this.frameListeners.add(listener)
    return () => this.frameListeners.delete(listener)
  }

  onState(listener: TerminalConnectionStateListener): () => void {
    this.stateListeners.add(listener)
    queueMicrotask(() => {
      if (this.stateListeners.has(listener)) listener(this.stateValue)
    })
    return () => this.stateListeners.delete(listener)
  }

  protected emitBytes(bytes: ArrayBuffer | Uint8Array | number[]): void {
    const frame = decodeTerminalFrame(
      Array.isArray(bytes) ? new Uint8Array(bytes) : (bytes as ArrayBuffer | Uint8Array)
    )
    for (const listener of this.frameListeners) listener(frame)
  }

  protected setState(state: TerminalHostConnectionState): void {
    if (state === this.stateValue) return
    this.stateValue = state
    for (const listener of this.stateListeners) listener(state)
  }
}

export class LanTerminalHostConnection extends BaseHostConnection {
  readonly transport = "lan" as const
  private socket: WebSocket | null = null

  constructor(
    private readonly url: string,
    private readonly factory: (url: string) => WebSocket = (value) => new WebSocket(value),
    readonly clientId?: string
  ) {
    super()
  }

  async open(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return
    this.setState("connecting")
    const socket = this.factory(this.url)
    socket.binaryType = "arraybuffer"
    this.socket = socket
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener(
        "open",
        () => {
          this.setState("connected")
          resolve()
        },
        { once: true }
      )
      socket.addEventListener("error", () => reject(new Error("terminal LAN connection failed")), {
        once: true,
      })
      socket.addEventListener("message", (event) => {
        if (event.data instanceof ArrayBuffer) this.emitBytes(event.data)
      })
      socket.addEventListener("close", () => this.setState("closed"), { once: true })
    })
  }

  async send(frame: TerminalFrame): Promise<void> {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      throw new Error("terminal LAN connection is not open")
    }
    this.socket.send(encodeTerminalFrame(frame) as Uint8Array<ArrayBuffer>)
  }

  async close(): Promise<void> {
    this.socket?.close()
    this.socket = null
    this.setState("closed")
  }
}

export class WanTerminalHostConnection extends BaseHostConnection {
  readonly transport = "wan" as const
  private sequence = BigInt(1)
  private wired = false

  constructor(
    private readonly channel: RTCDataChannel,
    readonly clientId?: string
  ) {
    super()
    if (channel.label !== "cognia.terminal" || channel.ordered === false) {
      throw new Error(
        "terminal WebRTC channel must be reliable, ordered, and named cognia.terminal"
      )
    }
  }

  async open(): Promise<void> {
    if (this.channel.readyState === "open") {
      this.setState("connected")
      this.wire()
      return
    }
    await new Promise<void>((resolve, reject) => {
      this.channel.addEventListener(
        "open",
        () => {
          this.wire()
          this.setState("connected")
          resolve()
        },
        { once: true }
      )
      this.channel.addEventListener(
        "error",
        () => reject(new Error("terminal WAN channel failed")),
        {
          once: true,
        }
      )
    })
  }

  async send(frame: TerminalFrame): Promise<void> {
    if (this.channel.readyState !== "open") throw new Error("terminal WAN channel is not open")
    this.channel.send(encodeTerminalFrame(frame) as Uint8Array<ArrayBuffer>)
  }

  nextSequence(): bigint {
    const sequence = this.sequence
    this.sequence += BigInt(1)
    return sequence
  }

  async close(): Promise<void> {
    this.channel.close()
    this.setState("closed")
  }

  private wire(): void {
    if (this.wired) return
    this.wired = true
    this.channel.binaryType = "arraybuffer"
    this.channel.addEventListener("message", (event) => {
      if (event.data instanceof ArrayBuffer) this.emitBytes(event.data)
    })
    this.channel.addEventListener("close", () => this.setState("closed"), { once: true })
  }
}

/** Paired in-memory adapter used by protocol and controller-race tests. */
export class InMemoryTerminalHostConnection extends BaseHostConnection {
  readonly transport = "memory" as const
  private peer: InMemoryTerminalHostConnection | null = null

  static pair(): [InMemoryTerminalHostConnection, InMemoryTerminalHostConnection] {
    const first = new InMemoryTerminalHostConnection()
    const second = new InMemoryTerminalHostConnection()
    first.peer = second
    second.peer = first
    return [first, second]
  }

  async open(): Promise<void> {
    if (!this.peer) throw new Error("terminal memory connection has no peer")
    this.setState("connected")
  }

  async send(frame: TerminalFrame): Promise<void> {
    if (this.state !== "connected" || this.peer?.state !== "connected") {
      throw new Error("terminal memory connection is not open")
    }
    const bytes = encodeTerminalFrame(frame)
    queueMicrotask(() => this.peer?.emitBytes(bytes))
  }

  async close(): Promise<void> {
    this.setState("closed")
  }
}
