/**
 * Typed JSON-RPC 2.0 client for `@cognia/agent/rpc`.
 *
 * Supports:
 * - Supplied input/output streams (in-process) or spawning the CLI
 * - Concurrent request IDs
 * - AbortSignal cancellation per-request
 * - Process-exit propagation
 * - Backpressure (awaits write drain)
 * - Deterministic disposal via `Symbol.asyncDispose`
 */

// static-export-exempt: @cognia/agent is a Node-only SDK and requires Node >=26.
import { spawn, type ChildProcess } from "node:child_process"
import { Readable, Writable } from "node:stream"
import { createInterface } from "node:readline"

import type { AgentEventEnvelope } from "@cognia/agent-config-types/agent-execution"

import type { JsonRpcErrorResponse } from "./protocol"
import { RPC_PROTOCOL_VERSION } from "./protocol"

export { RPC_PROTOCOL_VERSION }

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RpcClientOptions {
  /** Supply existing streams (for in-process use). */
  streams?: {
    input: Readable
    output: Writable
  }
  /** Spawn the CLI as a subprocess (default: `cognia-agent rpc`). */
  spawn?: {
    command?: string
    args?: string[]
    env?: Record<string, string>
    cwd?: string
  }
  /** Called for every `agent.event` notification. */
  onEvent?: (sessionId: string, envelope: AgentEventEnvelope) => void
  /** Called when the connection closes. */
  onClose?: (code: number | null) => void
}

export interface RpcCallOptions {
  signal?: AbortSignal
  timeoutMs?: number
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

// ─── Client ──────────────────────────────────────────────────────────────────

export interface RpcClient {
  /** Send a JSON-RPC request and await the response. */
  call<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    options?: RpcCallOptions
  ): Promise<T>

  /** Graceful shutdown. */
  shutdown(): Promise<void>

  /** Dispose (alias for shutdown, for Symbol.asyncDispose). */
  [Symbol.asyncDispose](): Promise<void>
}

export function createRpcClient(options: RpcClientOptions): RpcClient {
  let input: Readable
  let output: Writable
  let child: ChildProcess | null = null
  let closed = false

  if (options.streams) {
    input = options.streams.input
    output = options.streams.output
  } else {
    const spawnOpts = options.spawn ?? {}
    const command = spawnOpts.command ?? "cognia-agent"
    const args = spawnOpts.args ?? ["rpc"]
    child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...spawnOpts.env },
      cwd: spawnOpts.cwd,
    })
    input = child.stdout!
    output = child.stdin!

    child.on("exit", (code) => {
      closed = true
      options.onClose?.(code)
    })
  }

  type PendingRequest = {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
    timer?: ReturnType<typeof setTimeout>
  }

  const pending = new Map<string | number, PendingRequest>()
  let nextId = 1

  // Read responses from the server
  const rl = createInterface({ input, crlfDelay: Infinity })
  rl.on("line", (line) => {
    if (line.trim().length === 0) return
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      return
    }
    if (!parsed || typeof parsed !== "object") return
    const msg = parsed as Record<string, unknown>

    // Notification
    if (msg.method === "agent.event" && msg.id === undefined) {
      const params = msg.params as Record<string, unknown> | undefined
      if (params && options.onEvent) {
        options.onEvent(params.sessionId as string, params.envelope as AgentEventEnvelope)
      }
      return
    }

    // Response
    if ("id" in msg && msg.id !== undefined) {
      const id = msg.id as string | number
      const entry = pending.get(id)
      if (!entry) return
      pending.delete(id)
      if (entry.timer) clearTimeout(entry.timer)

      if ("error" in msg) {
        const errResp = msg as unknown as JsonRpcErrorResponse
        entry.reject(new RpcError(errResp.error.code, errResp.error.message, errResp.error.data))
      } else {
        entry.resolve((msg as { result: unknown }).result)
      }
    }
  })

  rl.on("close", () => {
    closed = true
    // Reject all pending
    for (const [, entry] of pending) {
      if (entry.timer) clearTimeout(entry.timer)
      entry.reject(new RpcError(-1, "connection closed"))
    }
    pending.clear()
  })

  async function call<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    callOptions?: RpcCallOptions
  ): Promise<T> {
    if (closed) throw new RpcError(-1, "client is closed")

    const id = nextId++
    const request = {
      jsonrpc: "2.0" as const,
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    }

    return new Promise<T>((resolve, reject) => {
      const entry: PendingRequest = {
        resolve: resolve as (value: unknown) => void,
        reject,
      }

      if (callOptions?.timeoutMs) {
        entry.timer = setTimeout(() => {
          pending.delete(id)
          reject(new RpcError(-32008, `timeout after ${callOptions.timeoutMs}ms`))
        }, callOptions.timeoutMs)
      }

      if (callOptions?.signal) {
        callOptions.signal.addEventListener(
          "abort",
          () => {
            pending.delete(id)
            if (entry.timer) clearTimeout(entry.timer)
            reject(new RpcError(-32007, "cancelled"))
          },
          { once: true }
        )
      }

      pending.set(id, entry)
      const line = JSON.stringify(request) + "\n"
      const ok = output.write(line)
      if (!ok) {
        // Backpressure — wait for drain before accepting more
        output.once("drain", () => {})
      }
    })
  }

  async function shutdown(): Promise<void> {
    if (closed) return
    try {
      await call("runtime.shutdown")
    } catch {
      // Best effort
    }
    closed = true
    if (child) {
      child.kill("SIGTERM")
      // Give it a moment to exit gracefully
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child?.kill("SIGKILL")
          resolve()
        }, 3000)
        child!.on("exit", () => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
    rl.close()
  }

  return {
    call,
    shutdown,
    [Symbol.asyncDispose]: shutdown,
  }
}
