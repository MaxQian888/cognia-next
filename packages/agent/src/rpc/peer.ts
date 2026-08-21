import {
  createLineReader,
  utf8ByteLength,
  type LineReader,
  type RpcReadable,
  type RpcWritable,
} from "./duplex"
import {
  HOST_NOTIFICATION_METHODS,
  HOST_REQUEST_METHODS,
  RPC_ERROR_CODES,
  isJsonRpcRequest,
  parseHostRequestParams,
  parseHostRequestResult,
  parseRpcMethodParams,
  parseRpcMethodResult,
  type HostNotificationMethod,
  type HostRequestMethod,
  type HostRequestMethodMap,
  type JsonRpcErrorResponse,
  type JsonRpcId,
  type RpcMethod,
  type RpcMethodMap,
} from "./protocol"

export interface RpcCallOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

export interface RpcPeerOptions {
  readable: RpcReadable
  writable: RpcWritable
  maxFrameBytes?: number
  maxOutboundBufferBytes?: number
  onClose?: (error?: Error) => void
}

export class RpcError extends Error {
  readonly code: number
  readonly data?: unknown

  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.name = "RpcError"
    this.code = code
    this.data = data
  }
}

type PendingRequest = {
  method: RpcMethod
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer?: ReturnType<typeof setTimeout>
  abortCleanup?: () => void
}

type RequestHandler<Method extends HostRequestMethod> = (
  params: HostRequestMethodMap[Method]["params"]
) => Promise<HostRequestMethodMap[Method]["result"]> | HostRequestMethodMap[Method]["result"]

export class RpcPeer {
  private readonly writable: RpcWritable
  private readonly lines: LineReader
  private readonly maxFrameBytes: number
  private readonly maxOutboundBufferBytes: number
  private readonly pending = new Map<JsonRpcId, PendingRequest>()
  private readonly requestHandlers = new Map<HostRequestMethod, RequestHandler<HostRequestMethod>>()
  private readonly notificationHandlers = new Map<
    HostNotificationMethod,
    Set<(params: Record<string, unknown>) => void>
  >()
  private nextId = 1
  private bufferedBytes = 0
  private closed = false

  constructor(options: RpcPeerOptions) {
    this.writable = options.writable
    this.maxFrameBytes = options.maxFrameBytes ?? 16 * 1024 * 1024
    this.maxOutboundBufferBytes = options.maxOutboundBufferBytes ?? 32 * 1024 * 1024
    this.lines = createLineReader(options.readable, {
      onLine: (line) => void this.consumeLine(line),
      onClose: () => this.close(new RpcError(-1, "connection closed")),
    })
    options.readable.on("error", (error: Error) => this.close(error))
    options.writable.on("error", (error: Error) => this.close(error))
    if (options.onClose) {
      const callback = options.onClose
      options.readable.once("close", () => callback())
      options.readable.once("error", callback)
    }
  }

  async call<Method extends RpcMethod>(
    method: Method,
    params: RpcMethodMap[Method]["params"],
    options: RpcCallOptions = {}
  ): Promise<RpcMethodMap[Method]["result"]> {
    if (this.closed) throw new RpcError(-1, "connection closed")
    if (options.signal?.aborted) throw new RpcError(RPC_ERROR_CODES.cancelled, "cancelled")

    const validated = parseRpcMethodParams(method, params)
    const id = this.nextId++
    const response = new Promise<unknown>((resolve, reject) => {
      const pending: PendingRequest = { method, resolve, reject }

      if (options.timeoutMs !== undefined) {
        pending.timer = setTimeout(() => {
          this.pending.delete(id)
          pending.abortCleanup?.()
          reject(new RpcError(RPC_ERROR_CODES.timeout, `timeout after ${options.timeoutMs}ms`))
        }, options.timeoutMs)
      }

      if (options.signal) {
        const onAbort = () => {
          this.pending.delete(id)
          if (pending.timer) clearTimeout(pending.timer)
          reject(new RpcError(RPC_ERROR_CODES.cancelled, "cancelled"))
        }
        options.signal.addEventListener("abort", onAbort, { once: true })
        pending.abortCleanup = () => options.signal?.removeEventListener("abort", onAbort)
      }

      this.pending.set(id, pending)
    })

    try {
      await this.write({ jsonrpc: "2.0", id, method, params: validated })
    } catch (error) {
      const pending = this.pending.get(id)
      this.pending.delete(id)
      if (pending?.timer) clearTimeout(pending.timer)
      pending?.abortCleanup?.()
      pending?.reject(error instanceof Error ? error : new Error(String(error)))
    }

    return (await response) as RpcMethodMap[Method]["result"]
  }

  async notify<Method extends RpcMethod>(
    method: Method,
    params: RpcMethodMap[Method]["params"]
  ): Promise<void> {
    const validated = parseRpcMethodParams(method, params)
    await this.write({ jsonrpc: "2.0", method, params: validated })
  }

  handle<Method extends HostRequestMethod>(method: Method, handler: RequestHandler<Method>): void {
    this.requestHandlers.set(method, handler as unknown as RequestHandler<HostRequestMethod>)
  }

  onNotification(
    method: HostNotificationMethod,
    handler: (params: Record<string, unknown>) => void
  ): () => void {
    const handlers = this.notificationHandlers.get(method) ?? new Set()
    handlers.add(handler)
    this.notificationHandlers.set(method, handlers)
    return () => handlers.delete(handler)
  }

  close(error: Error = new RpcError(-1, "connection closed")): void {
    if (this.closed) return
    this.closed = true
    this.lines.close()
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer)
      pending.abortCleanup?.()
      pending.reject(error)
    }
    this.pending.clear()
  }

  private async consumeLine(line: string): Promise<void> {
    if (utf8ByteLength(line) > this.maxFrameBytes) {
      this.close(
        new RpcError(
          RPC_ERROR_CODES.backpressureExceeded,
          "incoming frame exceeds negotiated limit"
        )
      )
      return
    }

    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      this.close(new RpcError(RPC_ERROR_CODES.parseError, "invalid JSON from host"))
      return
    }
    if (!message || typeof message !== "object") return
    const record = message as Record<string, unknown>

    if (
      isJsonRpcRequest(record) &&
      HOST_REQUEST_METHODS.includes(record.method as HostRequestMethod)
    ) {
      await this.dispatchRequest(record.id, record.method as HostRequestMethod, record.params)
      return
    }

    if (record.id !== undefined && ("result" in record || "error" in record)) {
      this.consumeResponse(record)
      return
    }

    if (
      record.id === undefined &&
      typeof record.method === "string" &&
      HOST_NOTIFICATION_METHODS.includes(record.method as HostNotificationMethod)
    ) {
      const params = record.params
      if (!params || typeof params !== "object") return
      for (const handler of this.notificationHandlers.get(
        record.method as HostNotificationMethod
      ) ?? []) {
        handler(params as Record<string, unknown>)
      }
    }
  }

  private consumeResponse(record: Record<string, unknown>): void {
    const id = record.id as JsonRpcId
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    if (pending.timer) clearTimeout(pending.timer)
    pending.abortCleanup?.()

    if ("error" in record) {
      const response = record as unknown as JsonRpcErrorResponse
      pending.reject(new RpcError(response.error.code, response.error.message, response.error.data))
      return
    }

    try {
      pending.resolve(parseRpcMethodResult(pending.method, record.result))
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private async dispatchRequest(
    id: JsonRpcId,
    method: HostRequestMethod,
    rawParams: unknown
  ): Promise<void> {
    const handler = this.requestHandlers.get(method)
    if (!handler) {
      await this.write({
        jsonrpc: "2.0",
        id,
        error: { code: RPC_ERROR_CODES.methodNotFound, message: `no client handler for ${method}` },
      })
      return
    }

    try {
      const params = parseHostRequestParams(method, rawParams)
      const result = parseHostRequestResult(method, await handler(params))
      await this.write({ jsonrpc: "2.0", id, result })
    } catch (error) {
      const rpcError = error instanceof RpcError ? error : null
      await this.write({
        jsonrpc: "2.0",
        id,
        error: {
          code: rpcError?.code ?? RPC_ERROR_CODES.callbackFailed,
          message: error instanceof Error ? error.message : String(error),
          ...(rpcError?.data !== undefined ? { data: rpcError.data } : {}),
        },
      })
    }
  }

  private async write(message: Record<string, unknown>): Promise<void> {
    if (this.closed) throw new RpcError(-1, "connection closed")
    const frame = `${JSON.stringify(message)}\n`
    const bytes = utf8ByteLength(frame)
    if (bytes > this.maxFrameBytes) {
      throw new RpcError(RPC_ERROR_CODES.invalidRequest, "outgoing frame exceeds negotiated limit")
    }
    if (this.bufferedBytes + bytes > this.maxOutboundBufferBytes) {
      const error = new RpcError(
        RPC_ERROR_CODES.backpressureExceeded,
        "outbound buffer exceeds negotiated limit"
      )
      this.close(error)
      throw error
    }

    this.bufferedBytes += bytes
    try {
      if (!this.writable.write(frame)) {
        await new Promise<void>((resolve, reject) => {
          const onDrain = () => {
            cleanup()
            resolve()
          }
          const onError = (error: Error) => {
            cleanup()
            reject(error)
          }
          const cleanup = () => {
            this.writable.off("drain", onDrain)
            this.writable.off("error", onError)
          }
          this.writable.once("drain", onDrain)
          this.writable.once("error", onError)
        })
      }
    } finally {
      this.bufferedBytes -= bytes
    }
  }
}
