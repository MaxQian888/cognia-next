/**
 * Transport-agnostic JSON-RPC peer.
 *
 * Factored out of `acp-client.ts` so the ACP adapter and the native Codex
 * `app-server` adapter share one framing + request/response-correlation core
 * instead of each carrying its own copy. The peer knows nothing about *how*
 * bytes move — the caller injects `writeRaw` (stdio invoke, WebSocket.send,
 * HTTP POST, …) and feeds inbound text back in via {@link JsonRpcPeer.ingest}.
 *
 * The single behavioural knob the two protocols differ on is the wire shape:
 * ACP includes the `"jsonrpc":"2.0"` envelope field; the Codex app-server
 * **omits** it (see https://developers.openai.com/codex/app-server). That is
 * controlled by `omitJsonRpcVersion` so the framing logic stays identical.
 */

export interface JsonRpcPeerOptions {
  /**
   * Omit the `"jsonrpc":"2.0"` field on every outbound message. The Codex
   * app-server speaks JSON-RPC with this field stripped on the wire; ACP keeps
   * it. Inbound parsing tolerates both regardless of this flag.
   */
  omitJsonRpcVersion?: boolean
  /** Serialize-and-write a single framed message to the underlying transport. */
  writeRaw: (message: string) => Promise<void> | void
  /** Handle an inbound notification (a message with `method` and no `id`). */
  onNotification?: (method: string, params: Record<string, unknown> | undefined) => void
  /**
   * Handle an inbound server→client request (a message with both `id` and
   * `method`). Resolve with the result value, or throw to send an error
   * response. Throwing an error carrying a numeric `code` property preserves
   * that JSON-RPC error code on the wire (defaults to `-32603`).
   */
  onServerRequest?: (
    method: string,
    params: Record<string, unknown> | undefined
  ) => Promise<unknown> | unknown
  /** Default per-request timeout in ms. */
  defaultTimeout?: number
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

interface JsonRpcInbound {
  jsonrpc?: string
  id?: number | string | null
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

/** An error carrying a JSON-RPC error code, used by `onServerRequest`. */
export class JsonRpcMethodError extends Error {
  constructor(
    public readonly code: number,
    message: string
  ) {
    super(message)
    this.name = "JsonRpcMethodError"
  }
}

export class JsonRpcPeer {
  private messageId = 0
  private readonly pending = new Map<number | string, PendingRequest>()
  private readonly buffer: string[] = []
  private processing = false
  private readonly defaultTimeout: number

  constructor(private readonly opts: JsonRpcPeerOptions) {
    this.defaultTimeout = opts.defaultTimeout ?? 30000
  }

  /**
   * Send a JSON-RPC request and resolve with its result. Rejects on timeout,
   * transport error, or a JSON-RPC error response (message `"<code>: <msg>"`,
   * mirroring the legacy ACP formatting so existing error detectors keep
   * working).
   */
  sendRequest<T>(
    method: string,
    params?: Record<string, unknown>,
    timeout: number = this.defaultTimeout
  ): Promise<T> {
    const id = ++this.messageId
    const message = this.envelope({ id, method, params })

    return new Promise<T>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Request timeout: ${method}`))
      }, timeout)

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout: timeoutId,
      })

      Promise.resolve(this.opts.writeRaw(message)).catch((error) => {
        clearTimeout(timeoutId)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      })
    })
  }

  /** Send a JSON-RPC notification (no id, no response expected). */
  sendNotification(method: string, params?: Record<string, unknown>): void {
    const message = this.envelope({ method, params })
    Promise.resolve(this.opts.writeRaw(message)).catch(() => {
      // Notifications are best-effort; a failed write is non-fatal.
    })
  }

  /**
   * Feed raw inbound transport text into the peer. Buffers and processes
   * newline-delimited frames so a single transport chunk carrying multiple
   * messages is split correctly.
   */
  ingest(raw: string): void {
    this.buffer.push(raw)
    if (!this.processing) {
      void this.process()
    }
  }

  /**
   * Reject every in-flight request — call on disconnect so callers don't hang
   * on a dead transport.
   */
  rejectAll(reason: string): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timeout)
      pending.reject(new Error(reason))
    }
    this.pending.clear()
  }

  private async process(): Promise<void> {
    this.processing = true
    while (this.buffer.length > 0) {
      const chunk = this.buffer.shift()!
      const lines = chunk.split("\n").filter((line) => line.trim())
      for (const line of lines) {
        let parsed: JsonRpcInbound
        try {
          parsed = JSON.parse(line) as JsonRpcInbound
        } catch {
          // Skip non-JSON noise (e.g. a stray banner line on stdout).
          continue
        }
        const hasId = "id" in parsed && parsed.id !== null && parsed.id !== undefined
        if (hasId && typeof parsed.method === "string") {
          await this.handleServerRequest(parsed.id!, parsed.method, parsed.params)
        } else if (hasId) {
          this.handleResponse(parsed)
        } else if (typeof parsed.method === "string") {
          this.opts.onNotification?.(parsed.method, parsed.params)
        }
      }
    }
    this.processing = false
  }

  private handleResponse(response: JsonRpcInbound): void {
    const pending = this.pending.get(response.id!)
    if (!pending) return
    clearTimeout(pending.timeout)
    this.pending.delete(response.id!)
    if (response.error) {
      pending.reject(new Error(`${response.error.code}: ${response.error.message}`))
    } else {
      pending.resolve(response.result)
    }
  }

  private async handleServerRequest(
    id: number | string,
    method: string,
    params: Record<string, unknown> | undefined
  ): Promise<void> {
    if (!this.opts.onServerRequest) {
      await this.writeResult(this.errorEnvelope(id, -32601, `Method not found: ${method}`))
      return
    }
    try {
      const result = await this.opts.onServerRequest(method, params)
      await this.writeResult(this.envelope({ id, result }))
    } catch (error) {
      const code = error instanceof JsonRpcMethodError ? error.code : -32603
      const message = error instanceof Error ? error.message : String(error)
      await this.writeResult(this.errorEnvelope(id, code, message))
    }
  }

  private async writeResult(message: string): Promise<void> {
    try {
      await this.opts.writeRaw(message)
    } catch {
      // Best-effort: the transport may already be gone.
    }
  }

  /** Build an outbound frame, including `jsonrpc` unless suppressed. */
  private envelope(fields: Record<string, unknown>): string {
    const payload = this.opts.omitJsonRpcVersion ? fields : { jsonrpc: "2.0", ...fields }
    return JSON.stringify(payload)
  }

  private errorEnvelope(id: number | string, code: number, message: string): string {
    return this.envelope({ id, error: { code, message } })
  }
}
