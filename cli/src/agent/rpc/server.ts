import { createInterface, type Interface as ReadlineInterface } from "node:readline"
import type { Readable, Writable } from "node:stream"

import {
  RPC_ERROR_CODES,
  RPC_PROTOCOL_VERSION,
  RpcValidationError,
  isJsonRpcRequest,
  makeErrorResponse,
  makeNotification,
  makeSuccessResponse,
  parseHostRequestResult,
  parseRpcMethodParams,
  parseRpcMethodResult,
  type HostNotificationMethod,
  type HostRequestMethod,
  type HostRequestMethodMap,
  type JsonRpcId,
  type RpcMethod,
  type RpcMethodMap,
} from "@/packages/agent/src/protocol"
import type { AgentWorkerManifestV1 } from "@/packages/agent/src/types"

export interface AgentRpcServiceContext {
  emit(method: HostNotificationMethod, params: Record<string, unknown>): Promise<void>
  requestClient<Method extends HostRequestMethod>(
    method: Method,
    params: HostRequestMethodMap[Method]["params"],
    options?: { timeoutMs?: number; signal?: AbortSignal }
  ): Promise<HostRequestMethodMap[Method]["result"]>
}

export interface AgentRpcService {
  readonly methods: readonly RpcMethod[]
  readonly capabilities: readonly string[]
  readonly workerManifest?: AgentWorkerManifestV1
  handle<Method extends RpcMethod>(
    method: Method,
    params: RpcMethodMap[Method]["params"],
    context: AgentRpcServiceContext
  ): Promise<RpcMethodMap[Method]["result"]> | RpcMethodMap[Method]["result"]
  close(): Promise<void>
}

export interface AgentRpcServerOptions {
  input: Readable
  output: Writable
  diagnostic: Writable
  service: AgentRpcService
  hostVersion: string
  runtimeVersion: string
  instanceId: string
  limits?: Partial<RpcLimits>
}

export interface RpcLimits {
  maxOpenSessions: number
  maxActiveTurns: number
  maxFrameBytes: number
  maxReplayEvents: number
  maxOutboundBufferBytes: number
}

export interface AgentRpcServer {
  serve(): Promise<void>
  close(): Promise<void>
}

export class AgentRpcHostError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown
  ) {
    super(message)
    this.name = "AgentRpcHostError"
  }
}

const DEFAULT_LIMITS: RpcLimits = {
  maxOpenSessions: 32,
  maxActiveTurns: 8,
  maxFrameBytes: 16 * 1024 * 1024,
  maxReplayEvents: 10_000,
  maxOutboundBufferBytes: 32 * 1024 * 1024,
}

type PendingClientRequest = {
  method: HostRequestMethod
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timer?: ReturnType<typeof setTimeout>
  abortCleanup?: () => void
}

export function createAgentRpcServer(options: AgentRpcServerOptions): AgentRpcServer {
  const limits = { ...DEFAULT_LIMITS, ...options.limits }
  const publicMethods = [
    "initialize",
    "initialized",
    "shutdown",
    ...options.service.methods,
  ] as const satisfies readonly RpcMethod[]
  const pendingClientRequests = new Map<JsonRpcId, PendingClientRequest>()
  let nextClientRequestId = 1_000_000
  let state: "new" | "initializing" | "ready" | "closed" = "new"
  let closing: Promise<void> | null = null
  let bufferedBytes = 0
  let lines: ReadlineInterface | null = null

  const context: AgentRpcServiceContext = {
    emit(method, params) {
      return write(makeNotification(method, params))
    },
    requestClient(method, params, callOptions = {}) {
      if (state !== "ready") {
        return Promise.reject(
          new AgentRpcHostError(RPC_ERROR_CODES.protocolError, "client is not initialized")
        )
      }
      const id = nextClientRequestId++
      const response = new Promise<unknown>((resolve, reject) => {
        const pending: PendingClientRequest = { method, resolve, reject }
        if (callOptions.timeoutMs !== undefined) {
          pending.timer = setTimeout(() => {
            pendingClientRequests.delete(id)
            pending.abortCleanup?.()
            reject(
              new AgentRpcHostError(
                RPC_ERROR_CODES.timeout,
                `client callback timed out after ${callOptions.timeoutMs}ms`
              )
            )
          }, callOptions.timeoutMs)
        }
        if (callOptions.signal) {
          const onAbort = () => {
            pendingClientRequests.delete(id)
            if (pending.timer) clearTimeout(pending.timer)
            reject(new AgentRpcHostError(RPC_ERROR_CODES.cancelled, "client callback cancelled"))
          }
          callOptions.signal.addEventListener("abort", onAbort, { once: true })
          pending.abortCleanup = () => callOptions.signal?.removeEventListener("abort", onAbort)
        }
        pendingClientRequests.set(id, pending)
      })
      return write({ jsonrpc: "2.0", id, method, params })
        .then(() => response)
        .then((result) => result as HostRequestMethodMap[typeof method]["result"])
    },
  }

  async function write(message: object): Promise<void> {
    if (state === "closed") throw new AgentRpcHostError(-1, "connection closed")
    const frame = `${JSON.stringify(message)}\n`
    const bytes = Buffer.byteLength(frame)
    if (bytes > limits.maxFrameBytes) {
      throw new AgentRpcHostError(RPC_ERROR_CODES.invalidRequest, "outgoing frame too large")
    }
    if (bufferedBytes + bytes > limits.maxOutboundBufferBytes) {
      const error = new AgentRpcHostError(
        RPC_ERROR_CODES.backpressureExceeded,
        "outbound buffer limit exceeded"
      )
      await close(error)
      throw error
    }
    bufferedBytes += bytes
    try {
      if (!options.output.write(frame)) {
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
            options.output.off("drain", onDrain)
            options.output.off("error", onError)
          }
          options.output.once("drain", onDrain)
          options.output.once("error", onError)
        })
      }
    } finally {
      bufferedBytes -= bytes
    }
  }

  async function dispatchRequest(
    id: JsonRpcId,
    methodName: string,
    rawParams: unknown
  ): Promise<void> {
    if (methodName === "initialize") {
      await initialize(id, rawParams)
      return
    }
    if (state !== "ready") {
      await write(
        makeErrorResponse(id, RPC_ERROR_CODES.protocolError, "initialize/initialized required")
      )
      return
    }
    if (methodName === "shutdown") {
      try {
        const params = parseRpcMethodParams("shutdown", rawParams ?? {})
        const result = parseRpcMethodResult("shutdown", { ok: true })
        void params
        await write(makeSuccessResponse(id, result))
      } catch (error) {
        await writeError(id, error)
        return
      }
      await close(new Error("client requested shutdown"))
      return
    }
    if (!publicMethods.includes(methodName as RpcMethod)) {
      await write(
        makeErrorResponse(
          id,
          RPC_ERROR_CODES.capabilityError,
          `method is not supported by this host: ${methodName}`
        )
      )
      return
    }

    const method = methodName as RpcMethod
    try {
      const params = parseRpcMethodParams(method, rawParams ?? {})
      const result = parseRpcMethodResult(
        method,
        await options.service.handle(method, params, context)
      )
      await write(makeSuccessResponse(id, result))
    } catch (error) {
      await writeError(id, error)
    }
  }

  async function initialize(id: JsonRpcId, rawParams: unknown): Promise<void> {
    if (state !== "new") {
      await write(makeErrorResponse(id, RPC_ERROR_CODES.protocolError, "already initialized"))
      return
    }
    try {
      const params = parseRpcMethodParams("initialize", rawParams ?? {})
      if (!params.protocolVersions.includes(RPC_PROTOCOL_VERSION)) {
        throw new AgentRpcHostError(
          RPC_ERROR_CODES.incompatibleHost,
          `no compatible protocol; host supports v${RPC_PROTOCOL_VERSION}`,
          { supportedProtocolVersions: [RPC_PROTOCOL_VERSION] }
        )
      }
      state = "initializing"
      await write(
        makeSuccessResponse(id, {
          protocolVersion: RPC_PROTOCOL_VERSION,
          host: { name: "cognia-agent", version: options.hostVersion },
          runtimeVersion: options.runtimeVersion,
          instanceId: options.instanceId,
          methods: publicMethods,
          capabilities: options.service.capabilities,
          limits,
          ...(options.service.workerManifest
            ? { workerManifest: options.service.workerManifest }
            : {}),
        })
      )
    } catch (error) {
      state = "new"
      await writeError(id, error)
    }
  }

  async function consumeResponse(record: Record<string, unknown>): Promise<void> {
    const id = record.id as JsonRpcId
    const pending = pendingClientRequests.get(id)
    if (!pending) return
    pendingClientRequests.delete(id)
    if (pending.timer) clearTimeout(pending.timer)
    pending.abortCleanup?.()
    if (record.error && typeof record.error === "object") {
      const error = record.error as Record<string, unknown>
      pending.reject(
        new AgentRpcHostError(
          typeof error.code === "number" ? error.code : RPC_ERROR_CODES.callbackFailed,
          typeof error.message === "string" ? error.message : "client callback failed",
          error.data
        )
      )
      return
    }
    try {
      pending.resolve(parseHostRequestResult(pending.method, record.result))
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error(String(error)))
    }
  }

  async function consumeLine(line: string): Promise<void> {
    if (Buffer.byteLength(line) > limits.maxFrameBytes) {
      await close(new AgentRpcHostError(RPC_ERROR_CODES.invalidRequest, "incoming frame too large"))
      return
    }
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      await write(makeErrorResponse(0, RPC_ERROR_CODES.parseError, "invalid JSON"))
      return
    }
    if (!message || typeof message !== "object") {
      await write(makeErrorResponse(0, RPC_ERROR_CODES.invalidRequest, "invalid JSON-RPC message"))
      return
    }
    const record = message as Record<string, unknown>
    if (record.id !== undefined && ("result" in record || "error" in record)) {
      await consumeResponse(record)
      return
    }
    if (record.id === undefined && record.method === "initialized") {
      if (state !== "initializing") return
      try {
        parseRpcMethodParams("initialized", record.params ?? {})
        state = "ready"
      } catch {
        await close(new AgentRpcHostError(RPC_ERROR_CODES.protocolError, "invalid initialized"))
      }
      return
    }
    if (!isJsonRpcRequest(record)) {
      await write(makeErrorResponse(0, RPC_ERROR_CODES.invalidRequest, "invalid JSON-RPC request"))
      return
    }
    await dispatchRequest(record.id, record.method, record.params)
  }

  async function writeError(id: JsonRpcId, error: unknown): Promise<void> {
    if (error instanceof RpcValidationError) {
      await write(
        makeErrorResponse(id, RPC_ERROR_CODES.invalidParams, error.message, {
          issues: error.issues,
        })
      )
      return
    }
    if (error instanceof AgentRpcHostError) {
      await write(makeErrorResponse(id, error.code, error.message, error.data))
      return
    }
    const structured = (error as { structuredError?: { code?: string; message?: string } })
      ?.structuredError
    if (structured) {
      await write(
        makeErrorResponse(
          id,
          mapStructuredError(structured.code),
          structured.message ?? "agent operation failed",
          structured
        )
      )
      return
    }
    await write(
      makeErrorResponse(
        id,
        RPC_ERROR_CODES.internalError,
        error instanceof Error ? error.message : String(error)
      )
    )
  }

  async function close(error: Error = new Error("connection closed")): Promise<void> {
    if (closing) return closing
    state = "closed"
    closing = (async () => {
      for (const pending of pendingClientRequests.values()) {
        if (pending.timer) clearTimeout(pending.timer)
        pending.abortCleanup?.()
        pending.reject(error)
      }
      pendingClientRequests.clear()
      await options.service.close()
      lines?.close()
      options.input.destroy()
    })()
    return closing
  }

  async function serve(): Promise<void> {
    options.diagnostic.write(
      `${JSON.stringify({ level: "info", message: `cognia-agent rpc v${RPC_PROTOCOL_VERSION} ready` })}\n`
    )
    lines = createInterface({ input: options.input, crlfDelay: Infinity })
    for await (const line of lines) {
      if (state === "closed") break
      if (line.trim()) await consumeLine(line)
    }
    await close()
  }

  return { serve, close }
}

function mapStructuredError(code: string | undefined): number {
  switch (code) {
    case "session_busy":
      return RPC_ERROR_CODES.sessionBusy
    case "session_not_found":
      return RPC_ERROR_CODES.sessionNotFound
    case "session_locked":
      return RPC_ERROR_CODES.sessionLocked
    case "permission_denied":
    case "resource_untrusted":
      return RPC_ERROR_CODES.permissionDenied
    case "unsupported_capability":
      return RPC_ERROR_CODES.capabilityError
    case "cancelled":
    case "interrupted":
      return RPC_ERROR_CODES.cancelled
    case "timeout":
    case "idle_timeout":
      return RPC_ERROR_CODES.timeout
    case "recovery_required":
      return RPC_ERROR_CODES.recoveryRequired
    case "config_error":
    case "usage_error":
      return RPC_ERROR_CODES.configError
    default:
      return RPC_ERROR_CODES.internalError
  }
}
