/**
 * JSON-RPC framing for the VS Code extension host sidecar.
 *
 * Protocol: line-delimited JSON over stdin/stdout. Each frame is a single
 * JSON object terminated by `\n`. Three message shapes:
 *
 *   { id, method, params }     // request — peer must reply with `id`
 *   { id, result }              // response — happy path
 *   { id, error }               // response — failure
 *   {     method, params }     // notification — no response expected
 *
 * The bridge layer in the renderer is the other end. Cognia's renderer
 * sends activate/deactivate/RPC commands; we send permission-request,
 * provider-invocation responses, command-registration notifications.
 *
 * The implementation is dependency-free so it can run in the bare Node
 * sidecar (no Tauri APIs, no @anthropic-ai/sdk, no React) — only
 * `vscode-jsonrpc` and `vscode-languageclient` for LSP support are
 * imported elsewhere.
 */

import type { Readable, Writable } from "node:stream"

export type RpcMethod = string

export interface RpcRequest {
  jsonrpc: "2.0"
  id: number
  method: RpcMethod
  params?: unknown
}

export interface RpcResponse {
  jsonrpc: "2.0"
  id: number
  result?: unknown
  error?: RpcError
}

export interface RpcNotification {
  jsonrpc: "2.0"
  method: RpcMethod
  params?: unknown
}

export interface RpcError {
  code: number
  message: string
  data?: unknown
}

export type RpcHandler = (params: unknown) => Promise<unknown> | unknown
export type NotificationHandler = (params: unknown) => void

export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  /** Cognia-specific — extension explicitly threw an error from its handler. */
  ExtensionError: -32000,
  /** Permission denied at the runtime gate. */
  PermissionDenied: -32001,
  /** Tier-4 surface — the VS Code API is not supported by cognia. */
  NotSupported: -32002,
} as const

export class RpcConnection {
  private nextId = 1
  private pendingRequests = new Map<
    number,
    {
      resolve: (value: unknown) => void
      reject: (error: RpcError) => void
    }
  >()
  private handlers = new Map<RpcMethod, RpcHandler>()
  private notifyHandlers = new Map<RpcMethod, NotificationHandler[]>()
  private buffer = ""
  private closed = false

  constructor(
    private readonly input: Readable,
    private readonly output: Writable
  ) {
    input.setEncoding("utf-8")
    input.on("data", (chunk: string) => this.onData(chunk))
    input.on("end", () => this.close())
    input.on("error", () => this.close())
  }

  /** Register a request handler. Replaces any existing handler. */
  onRequest(method: RpcMethod, handler: RpcHandler): void {
    this.handlers.set(method, handler)
  }

  /** Register a notification handler — multiple are supported per method. */
  onNotification(method: RpcMethod, handler: NotificationHandler): void {
    let list = this.notifyHandlers.get(method)
    if (!list) {
      list = []
      this.notifyHandlers.set(method, list)
    }
    list.push(handler)
  }

  /** Send a request, await the response. */
  async sendRequest<T = unknown>(method: RpcMethod, params?: unknown): Promise<T> {
    if (this.closed) {
      throw { code: ErrorCode.InternalError, message: "RPC connection closed" } as RpcError
    }
    const id = this.nextId++
    const request: RpcRequest = { jsonrpc: "2.0", id, method, params }
    const promise = new Promise<T>((resolve, reject) => {
      this.pendingRequests.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      })
    })
    this.write(request)
    return promise
  }

  /** Send a fire-and-forget notification. */
  sendNotification(method: RpcMethod, params?: unknown): void {
    if (this.closed) return
    const notification: RpcNotification = { jsonrpc: "2.0", method, params }
    this.write(notification)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const [, pending] of this.pendingRequests) {
      pending.reject({ code: ErrorCode.InternalError, message: "RPC connection closed" })
    }
    this.pendingRequests.clear()
  }

  private onData(chunk: string): void {
    if (this.closed) return
    this.buffer += chunk
    let idx = this.buffer.indexOf("\n")
    while (idx !== -1) {
      const line = this.buffer.slice(0, idx)
      this.buffer = this.buffer.slice(idx + 1)
      if (line.length > 0) {
        try {
          const message = JSON.parse(line) as RpcRequest | RpcResponse | RpcNotification
          this.dispatch(message)
        } catch (err) {
          // Malformed line — emit a parse error if it had an id field.
          this.write({
            jsonrpc: "2.0",
            id: 0,
            error: {
              code: ErrorCode.ParseError,
              message: `Parse error: ${(err as Error).message}`,
            },
          })
        }
      }
      idx = this.buffer.indexOf("\n")
    }
  }

  private dispatch(message: RpcRequest | RpcResponse | RpcNotification): void {
    if (isResponse(message)) {
      const pending = this.pendingRequests.get(message.id)
      if (!pending) return
      this.pendingRequests.delete(message.id)
      if (message.error) {
        pending.reject(message.error)
      } else {
        pending.resolve(message.result)
      }
      return
    }
    if (isRequest(message)) {
      void this.handleRequest(message)
      return
    }
    if (isNotification(message)) {
      this.handleNotification(message)
    }
  }

  private async handleRequest(request: RpcRequest): Promise<void> {
    const handler = this.handlers.get(request.method)
    if (!handler) {
      this.write({
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: ErrorCode.MethodNotFound,
          message: `Method not found: ${request.method}`,
        },
      })
      return
    }
    try {
      const result = await handler(request.params)
      this.write({ jsonrpc: "2.0", id: request.id, result })
    } catch (err) {
      const error = isRpcError(err)
        ? err
        : {
            code: ErrorCode.ExtensionError,
            message: err instanceof Error ? err.message : String(err),
          }
      this.write({ jsonrpc: "2.0", id: request.id, error })
    }
  }

  private handleNotification(notification: RpcNotification): void {
    const handlers = this.notifyHandlers.get(notification.method)
    if (!handlers) return
    for (const handler of handlers) {
      try {
        handler(notification.params)
      } catch (err) {
        // Best-effort log; notifications can't fail back to the peer.
        process.stderr.write(
          `[vscode-ext-host] notification handler ${notification.method} threw: ${
            err instanceof Error ? err.message : String(err)
          }\n`
        )
      }
    }
  }

  private write(message: RpcRequest | RpcResponse | RpcNotification): void {
    try {
      this.output.write(`${JSON.stringify(message)}\n`)
    } catch (err) {
      process.stderr.write(
        `[vscode-ext-host] failed to write RPC: ${
          err instanceof Error ? err.message : String(err)
        }\n`
      )
    }
  }
}

function isResponse(message: unknown): message is RpcResponse {
  return (
    !!message &&
    typeof message === "object" &&
    typeof (message as { id?: unknown }).id === "number" &&
    !(message as { method?: unknown }).method
  )
}

function isRequest(message: unknown): message is RpcRequest {
  return (
    !!message &&
    typeof message === "object" &&
    typeof (message as { id?: unknown }).id === "number" &&
    typeof (message as { method?: unknown }).method === "string"
  )
}

function isNotification(message: unknown): message is RpcNotification {
  return (
    !!message &&
    typeof message === "object" &&
    typeof (message as { method?: unknown }).method === "string" &&
    !("id" in (message as object))
  )
}

function isRpcError(err: unknown): err is RpcError {
  return (
    !!err &&
    typeof err === "object" &&
    typeof (err as { code?: unknown }).code === "number" &&
    typeof (err as { message?: unknown }).message === "string"
  )
}
