import type { AgentOutboundGate } from "@cognia/agent-contracts"
import { LfFrameDecoder } from "@cognia/agent-runtime-kit"
import {
  OmpChunkDecoder,
  OmpProtocolError,
  encodeOmpFrame,
  OMP_MAX_FRAME_BYTES,
  OMP_MAX_REASSEMBLED_BYTES,
  type OmpCommandMap,
  type OmpCommandName,
  type OmpOutboundFrame,
  type OmpServerFrame,
  type PromptParams,
  type AbortAndPromptParams,
  type PromptAck,
  type PromptResultEvent,
  type ReadyEvent,
  type RpcInbound,
} from "./wire"

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: Error) => void
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  // The owner can attach after synchronous feed/dispose without an unhandled rejection.
  void promise.catch(() => {})
  return { promise, resolve, reject }
}
function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

export class OmpRpcError extends Error {
  constructor(
    message: string,
    readonly command: string,
    readonly code?: string
  ) {
    super(message)
    this.name = "OmpRpcError"
  }
}

/** A rejected payload that never reached the transport or native process. */
export class OmpLocalRequestError extends OmpProtocolError {}

export interface OmpRpcPeerOptions {
  send: (line: string) => Promise<void>
  outboundGate: AgentOutboundGate
  /** All non-response frames, including prompt results and host callback requests. */
  onEvent?: (frame: OmpServerFrame) => void
  onFatal?: (error: Error) => void
  timeoutMs?: number
  promptTimeoutMs?: number
}
export interface OmpPromptTicket {
  id: string
  ack: Promise<PromptAck | undefined>
  result: Promise<PromptResultEvent>
}
interface Pending {
  command: OmpCommandName
  protocolVersion?: number
  completion: Deferred<unknown>
  timer: ReturnType<typeof setTimeout>
}
interface PromptPending {
  completion: Deferred<PromptResultEvent>
  timer: ReturnType<typeof setTimeout>
}
type RequestArguments<K extends OmpCommandName> = undefined extends OmpCommandMap[K]["params"]
  ? [params?: OmpCommandMap[K]["params"], timeoutMs?: number]
  : [params: OmpCommandMap[K]["params"], timeoutMs?: number]

/** Host-neutral OMP JSONL peer. The host owns process lifetime and calls end() on EOF. */
export class OmpRpcPeer {
  private readonly startup = deferred<ReadyEvent>()
  private startupTimer: ReturnType<typeof setTimeout>
  private readonly frames = new LfFrameDecoder({
    label: "OMP RPC",
    maxFrameBytes: OMP_MAX_FRAME_BYTES - 1,
    maxBufferBytes: OMP_MAX_FRAME_BYTES - 1,
  })
  private readonly chunks = new OmpChunkDecoder()
  private readonly utf8 = new TextDecoder("utf-8", { fatal: true })
  private readonly pending = new Map<string, Pending>()
  private readonly prompts = new Map<string, PromptPending>()
  private count = 0
  private closed?: Error
  private readyFrame?: ReadyEvent
  private protocol = 1
  private frameLimit = OMP_MAX_FRAME_BYTES
  private settled = false

  constructor(private readonly options: OmpRpcPeerOptions) {
    if (typeof options.outboundGate !== "function")
      throw new TypeError("OMP outboundGate is required")
    this.startupTimer = setTimeout(
      () => this.fail(new OmpProtocolError("OMP ready timed out")),
      options.timeoutMs ?? 30_000
    )
  }

  get protocolVersion(): number {
    return this.protocol
  }
  get pendingCount(): number {
    return this.pending.size
  }
  get promptCount(): number {
    return this.prompts.size
  }
  ready(): Promise<ReadyEvent> {
    return this.startup.promise
  }

  request<K extends OmpCommandName>(
    type: K,
    ...args: RequestArguments<K>
  ): Promise<OmpCommandMap[K]["result"]> {
    const [params, timeoutMs] = args
    const id = `omp-${++this.count}`
    return this.dispatch(type, params, id, timeoutMs) as Promise<OmpCommandMap[K]["result"]>
  }

  prompt(
    params: PromptParams | AbortAndPromptParams,
    type: "prompt" | "abort_and_prompt" = "prompt"
  ): OmpPromptTicket {
    const id = `omp-${++this.count}`
    const completion = deferred<PromptResultEvent>()
    const timer = setTimeout(
      () => {
        this.prompts.delete(id)
        completion.reject(
          new OmpRpcError("OMP prompt completion timed out; execution may still be running", type)
        )
      },
      this.options.promptTimeoutMs ?? 30 * 60_000
    )
    this.prompts.set(id, { completion, timer })
    const ack = this.dispatch(type, params, id) as Promise<PromptAck | undefined>
    void ack.catch((error: unknown) => this.rejectPrompt(id, asError(error)))
    return { id, ack, result: completion.promise }
  }

  async sendFrame(frame: RpcInbound): Promise<void> {
    await this.ready()
    await this.send(frame)
  }

  /** Feed raw stdout. Framing/protocol errors terminate all pending requests. */
  feed(chunk: Uint8Array | string): void {
    if (this.closed) return
    try {
      // The shared LF decoder owns buffering; this streaming decoder only checks
      // byte validity because its default decoding mode replaces invalid UTF-8.
      this.utf8.decode(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk, {
        stream: true,
      })
      for (const line of this.frames.push(chunk)) {
        if (new TextEncoder().encode(line).byteLength + 1 > this.frameLimit)
          throw new OmpProtocolError("OMP physical frame exceeds advertised limit")
        const physical: unknown = JSON.parse(line)
        if (
          typeof physical === "object" &&
          physical !== null &&
          "type" in physical &&
          physical.type === "rpc_chunk" &&
          this.protocol !== 2
        ) {
          throw new OmpProtocolError("OMP chunk received before protocol v2 negotiation")
        }
        const frame = this.chunks.push(physical)
        if (frame) this.accept(frame)
      }
    } catch (error) {
      this.fail(asError(error))
    }
  }

  receive(chunk: Uint8Array | string): void {
    this.feed(chunk)
  }

  end(): void {
    const truncated = this.frames.bufferedBytes > 0 || this.chunks.incomplete
    this.fail(
      new OmpProtocolError(
        truncated ? "OMP transport ended with an incomplete frame" : "OMP transport closed"
      )
    )
  }

  dispose(error = new OmpProtocolError("OMP peer disposed")): void {
    if (this.closed) return
    this.closed = error
    clearTimeout(this.startupTimer)
    this.startup.reject(error)
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.completion.reject(error)
    }
    this.pending.clear()
    for (const prompt of this.prompts.values()) {
      clearTimeout(prompt.timer)
      prompt.completion.reject(error)
    }
    this.prompts.clear()
    this.frames.reset()
    this.chunks.reset()
  }

  private async dispatch(
    type: OmpCommandName,
    params: unknown,
    id: string,
    timeoutMs?: number
  ): Promise<unknown> {
    if (type !== "negotiate_protocol") await this.ready()
    if (this.closed) throw this.closed
    const completion = deferred<unknown>()
    const timer = setTimeout(
      () => {
        this.pending.delete(id)
        completion.reject(new OmpRpcError(`OMP ${type} timed out; command was not replayed`, type))
      },
      timeoutMs ?? this.options.timeoutMs ?? 30_000
    )
    this.pending.set(id, {
      command: type,
      completion,
      timer,
      protocolVersion:
        type === "negotiate_protocol"
          ? (params as { protocolVersion: number }).protocolVersion
          : undefined,
    })
    const frame = { ...(params as object | undefined), type, id } as OmpOutboundFrame
    // Do not await transport before exposing the response promise: a transport may
    // deliver a response synchronously, or stall while the response times out.
    void this.send(frame).catch((error: unknown) => {
      const pending = this.pending.get(id)
      if (!pending) return
      this.pending.delete(id)
      clearTimeout(pending.timer)
      pending.completion.reject(asError(error))
    })
    return completion.promise
  }

  private async send(frame: OmpOutboundFrame): Promise<void> {
    if (this.closed) throw this.closed
    let line: string
    try {
      if (!this.options.outboundGate(frame))
        throw new OmpProtocolError("OMP outbound gate rejected payload")
      line = encodeOmpFrame(frame, this.frameLimit)
    } catch (error) {
      throw new OmpLocalRequestError(asError(error).message)
    }
    try {
      await this.options.send(line)
    } catch (error) {
      // A broken transport invalidates every pending request. Gate/size failures
      // above are local to this command and leave the process usable.
      this.fail(asError(error))
      throw error
    }
  }

  private accept(frame: Record<string, unknown>): void {
    if (frame.type === "ready") {
      if (this.readyFrame) throw new OmpProtocolError("Duplicate OMP ready frame")
      for (const key of ["maxFrameBytes", "maxReassembledFrameBytes"]) {
        if (
          frame[key] !== undefined &&
          (typeof frame[key] !== "number" ||
            !Number.isSafeInteger(frame[key]) ||
            (frame[key] as number) <= 0)
        ) {
          throw new OmpProtocolError(`Invalid OMP ${key}`)
        }
      }
      if (
        frame.supportedProtocolVersions !== undefined &&
        (!Array.isArray(frame.supportedProtocolVersions) ||
          !frame.supportedProtocolVersions.every(Number.isSafeInteger))
      ) {
        throw new OmpProtocolError("Invalid OMP protocol versions")
      }
      this.readyFrame = frame as unknown as ReadyEvent
      this.frameLimit = Math.min(
        this.readyFrame.maxFrameBytes ?? OMP_MAX_FRAME_BYTES,
        OMP_MAX_FRAME_BYTES
      )
      this.chunks.setLimit(this.readyFrame.maxReassembledFrameBytes ?? OMP_MAX_REASSEMBLED_BYTES)
      if (this.readyFrame.supportedProtocolVersions?.includes(2)) {
        void this.dispatch(
          "negotiate_protocol",
          { protocolVersion: 2 },
          `omp-${++this.count}`
        ).then(
          () => {
            clearTimeout(this.startupTimer)
            this.startup.resolve(this.readyFrame!)
          },
          (error: unknown) => this.fail(asError(error))
        )
      } else {
        clearTimeout(this.startupTimer)
        this.startup.resolve(this.readyFrame)
      }
    } else if (!this.readyFrame) {
      throw new OmpProtocolError("OMP frame received before ready")
    } else if (frame.type === "response") {
      if (typeof frame.id !== "string") return
      const pending = this.pending.get(frame.id)
      if (!pending) return // Late/duplicate response; never correlate by command alone.
      if (frame.command !== pending.command || typeof frame.success !== "boolean")
        throw new OmpProtocolError("Malformed or mismatched OMP response")
      this.pending.delete(frame.id)
      clearTimeout(pending.timer)
      if (!frame.success) {
        const error = new OmpRpcError(
          typeof frame.error === "string" ? frame.error : "OMP command failed",
          pending.command,
          typeof frame.code === "string" ? frame.code : undefined
        )
        pending.completion.reject(error)
        this.rejectPrompt(frame.id, error)
      } else {
        if (pending.command === "negotiate_protocol") {
          if (
            !frame.data ||
            typeof frame.data !== "object" ||
            !("protocolVersion" in frame.data) ||
            (frame.data.protocolVersion !== 1 && frame.data.protocolVersion !== 2) ||
            frame.data.protocolVersion !== pending.protocolVersion
          ) {
            pending.completion.reject(
              new OmpProtocolError("OMP refused requested protocol version")
            )
            throw new OmpProtocolError("OMP refused requested protocol version")
          }
          this.protocol = frame.data.protocolVersion
        }
        if (
          pending.command === "get_state" &&
          frame.data &&
          typeof frame.data === "object" &&
          "isSettled" in frame.data &&
          typeof frame.data.isSettled === "boolean"
        )
          this.settled = frame.data.isSettled
        pending.completion.resolve(frame.data)
        if (
          pending.command === "prompt" &&
          frame.data &&
          typeof frame.data === "object" &&
          "agentInvoked" in frame.data &&
          frame.data.agentInvoked === false
        ) {
          this.resolvePrompt({
            type: "prompt_result",
            id: frame.id,
            agentInvoked: false,
            status: "completed",
            sessionSettled: this.settled,
          })
        }
      }
      return
    } else if (frame.type === "prompt_result") {
      if (
        (frame.id !== undefined && typeof frame.id !== "string") ||
        typeof frame.agentInvoked !== "boolean" ||
        typeof frame.sessionSettled !== "boolean" ||
        !["completed", "aborted", "error"].includes(String(frame.status))
      ) {
        throw new OmpProtocolError("Malformed OMP prompt result")
      }
      this.settled = frame.sessionSettled
      this.resolvePrompt(frame as unknown as PromptResultEvent)
    } else if (frame.type === "session_settled") this.settled = true
    else if (frame.type === "agent_start") this.settled = false
    else if (frame.type === "rpc_frame_error")
      throw new OmpProtocolError(
        typeof frame.error === "string" ? frame.error : "OMP frame overflow"
      )
    this.options.onEvent?.(frame as unknown as OmpServerFrame)
  }

  private resolvePrompt(result: PromptResultEvent): void {
    if (!result.id) return
    const prompt = this.prompts.get(result.id)
    if (!prompt) return
    this.prompts.delete(result.id)
    clearTimeout(prompt.timer)
    prompt.completion.resolve(result)
  }

  private rejectPrompt(id: string, error: Error): void {
    const prompt = this.prompts.get(id)
    if (!prompt) return
    this.prompts.delete(id)
    clearTimeout(prompt.timer)
    prompt.completion.reject(error)
  }

  private fail(error: Error): void {
    if (this.closed) return
    this.dispose(error)
    this.options.onFatal?.(error)
  }
}
