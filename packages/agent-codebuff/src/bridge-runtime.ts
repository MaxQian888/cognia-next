import { encodeBridgeFrame, parseBridgeFrame, type BridgeFrame } from "./bridge-protocol"

/** Structural surface verified against published @codebuff/sdk 0.10.7 declarations. */
export interface CodebuffSdkRun {
  agent: string
  prompt: string
  previousRun?: unknown
  signal: AbortSignal
}
export interface CodebuffSdkClient {
  run(options: CodebuffSdkRun): Promise<unknown>
}
export interface CodebuffBridgeHost {
  send(frame: BridgeFrame): Promise<void>
  createClient(options: {
    cwd: string
    requestPermission(name: string, input: Record<string, unknown>): Promise<boolean>
    fetch: typeof fetch
    onEvent(event: unknown): void
    onChunk(chunk: unknown): void
  }): Promise<CodebuffSdkClient>
}
interface FetchState {
  resolve(response: Response): void
  reject(error: Error): void
  controller?: ReadableStreamDefaultController<Uint8Array>
  pending?: { data: Uint8Array; seq: number }
  cleanup?(): void
}

/** Node-independent engine; the Node entry provides native, confined SDK IO. */
export class CodebuffBridgeRuntime {
  private client?: CodebuffSdkClient
  private turn?: { id: string; controller: AbortController }
  private requests = new Map<
    string,
    { resolve(value: unknown): void; reject(error: Error): void }
  >()
  private fetches = new Map<string, FetchState>()
  constructor(private readonly host: CodebuffBridgeHost) {}
  async receive(line: string): Promise<void> {
    const frame = parseBridgeFrame(line)
    const requestId = typeof frame.requestId === "string" ? frame.requestId : ""
    if (frame.type === "host-result") {
      const pending = this.requests.get(requestId)
      if (!pending) return
      this.requests.delete(requestId)
      if (frame.error) pending.reject(new Error("Codebuff host operation failed"))
      else pending.resolve(frame.result)
      return
    }
    if (frame.type.startsWith("network-")) {
      await this.networkFrame(frame)
      return
    }
    if (frame.type === "cancel") {
      const turn = this.turn
      if (turn && turn.id === frame.turnId) {
        turn.controller.abort()
        this.rejectPending()
      }
      return
    }
    if (frame.type === "init") {
      if (this.client || this.turn) throw new Error("Codebuff bridge is already initialized")
      if (typeof frame.cwd !== "string" || !frame.cwd)
        throw new Error("Codebuff bridge needs a workspace")
      this.client = await this.host.createClient({
        cwd: frame.cwd,
        requestPermission: (name, input) => this.ask(name, input),
        fetch: this.fetch,
        onEvent: (event) => this.forward("event", event),
        onChunk: (chunk) => this.forward("chunk", chunk),
      })
      await this.host.send({ type: "ready" })
      return
    }
    if (
      frame.type !== "run" ||
      !this.client ||
      this.turn ||
      typeof frame.turnId !== "string" ||
      typeof frame.prompt !== "string"
    )
      throw new Error("Invalid Codebuff bridge run state")
    if (
      typeof frame.agent !== "string" ||
      !/^codebuff\/[a-z0-9-]+@[0-9]+\.[0-9]+\.[0-9]+$/.test(frame.agent)
    )
      throw new Error("Codebuff agent must be an explicit official version")
    const turn = { id: frame.turnId, controller: new AbortController() }
    this.turn = turn
    // Do not block stdin dispatch: host replies and cancellation must reach a running SDK call.
    void this.client
      .run({
        agent: frame.agent,
        prompt: frame.prompt,
        previousRun: frame.previousRun,
        signal: turn.controller.signal,
      })
      .then(
        (state) => this.host.send({ type: "result", turnId: turn.id, state }),
        () =>
          this.host.send({
            type: "error",
            turnId: turn.id,
            error: turn.controller.signal.aborted
              ? "Codebuff run cancelled"
              : "Codebuff SDK execution failed",
          })
      )
      .catch(() =>
        this.host
          .send({ type: "error", turnId: turn.id, error: "Codebuff result exceeded bridge limits" })
          .catch(() => {})
      )
      .finally(() => {
        this.turn = undefined
        this.rejectPending()
      })
  }
  close(): void {
    this.turn?.controller.abort()
    this.rejectPending()
  }
  private forward(type: "event" | "chunk", value: unknown): void {
    if (this.turn)
      void this.host.send({ type, turnId: this.turn.id, [type]: value }).catch(() => this.close())
  }
  private rejectPending(): void {
    for (const p of this.requests.values()) p.reject(new Error("Codebuff operation cancelled"))
    this.requests.clear()
    for (const [id, p] of this.fetches) {
      p.cleanup?.()
      p.reject(new Error("Codebuff request cancelled"))
      p.controller?.error(new Error("Codebuff request cancelled"))
      void this.host.send({ type: "network-cancel", requestId: id }).catch(() => {})
    }
    this.fetches.clear()
  }
  private async ask(name: string, input: Record<string, unknown>): Promise<boolean> {
    const requestId = crypto.randomUUID()
    const result = new Promise<unknown>((resolve, reject) =>
      this.requests.set(requestId, { resolve, reject })
    )
    try {
      await this.host.send({ type: "host-request", requestId, kind: "approval", name, input })
      return (await result) === true
    } finally {
      this.requests.delete(requestId)
    }
  }
  readonly fetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init)
    const requestId = crypto.randomUUID()
    const body = request.body ? await readCodebuffBoundedText(request.body, 512 * 1024) : undefined
    request.signal.throwIfAborted()
    const result = new Promise<Response>((resolve, reject) =>
      this.fetches.set(requestId, { resolve, reject })
    )
    const abort = () => {
      const state = this.fetches.get(requestId)
      if (!state) return
      state.cleanup?.()
      state.reject(new Error("Codebuff fetch cancelled"))
      state.controller?.error(new Error("Codebuff fetch cancelled"))
      this.fetches.delete(requestId)
      void this.host.send({ type: "network-cancel", requestId }).catch(() => {})
    }
    request.signal.addEventListener("abort", abort, { once: true })
    this.fetches.get(requestId)!.cleanup = () => request.signal.removeEventListener("abort", abort)
    try {
      await this.host.send({
        type: "host-request",
        kind: "network",
        requestId,
        url: request.url,
        method: request.method,
        headers: Object.fromEntries(request.headers),
        body,
      })
      return await result
    } catch (error) {
      request.signal.removeEventListener("abort", abort)
      this.fetches.delete(requestId)
      throw error
    }
  }
  private async networkFrame(frame: BridgeFrame): Promise<void> {
    const id = String(frame.requestId),
      state = this.fetches.get(id)
    if (!state) return
    if (frame.type === "network-head") {
      const stream = new ReadableStream<Uint8Array>({
        start: (c) => {
          state.controller = c
        },
        pull: async () => {
          if (state.pending) {
            const chunk = state.pending
            state.pending = undefined
            state.controller!.enqueue(chunk.data)
            await this.host.send({ type: "network-ack", requestId: id, seq: chunk.seq })
          }
        },
        cancel: async () => {
          state.cleanup?.()
          this.fetches.delete(id)
          await this.host.send({ type: "network-cancel", requestId: id })
        },
      })
      const status = Number(frame.status)
      state.resolve(
        new Response([204, 205, 304].includes(status) ? null : stream, {
          status,
          headers: frame.headers as Record<string, string>,
        })
      )
      return
    }
    if (frame.type === "network-chunk") {
      if (
        typeof frame.data !== "string" ||
        frame.data.length > 90_000 ||
        !state.controller ||
        state.pending
      )
        throw new Error("Malformed or unbounded Codebuff network chunk")
      const data = Uint8Array.from(atob(frame.data), (c) => c.charCodeAt(0)),
        seq = Number(frame.seq)
      if ((state.controller.desiredSize ?? 0) > 0) {
        state.controller.enqueue(data)
        await this.host.send({ type: "network-ack", requestId: id, seq })
      } else state.pending = { data, seq }
    } else if (frame.type === "network-end") {
      if (state.pending)
        throw new Error("Codebuff response ended before backpressure acknowledgement")
      state.cleanup?.()
      state.controller?.close()
      this.fetches.delete(id)
    } else if (frame.type === "network-error") {
      state.cleanup?.()
      state.reject(new Error("Codebuff host network failed"))
      state.controller?.error(new Error("Codebuff host network failed"))
      this.fetches.delete(id)
    }
  }
}
/** Useful for entry points that receive objects instead of raw lines. */
export function codebuffBridgeLine(frame: BridgeFrame): string {
  return encodeBridgeFrame(frame)
}

export async function readCodebuffBoundedText(
  body: ReadableStream<Uint8Array>,
  limit: number
): Promise<string> {
  const reader = body.getReader(),
    decoder = new TextDecoder()
  let size = 0,
    text = ""
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) throw new Error("Codebuff network body exceeded the bridge limit")
      text += decoder.decode(value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
