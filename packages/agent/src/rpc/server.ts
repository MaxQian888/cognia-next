/**
 * JSON-RPC 2.0 server over newline-delimited UTF-8 JSON (ndjson).
 *
 * Reads from an input stream (stdin by default), dispatches to the public
 * `CogniaRuntime`/`CogniaSession` SDK, writes responses and notifications to
 * an output stream (stdout by default). Diagnostics go to stderr.
 *
 * This module is the implementation backing `cognia-agent rpc`. It is also
 * importable as `@cognia/agent/rpc` for in-process use with supplied streams.
 */

// static-export-exempt: @cognia/agent is a Node-only SDK and requires Node >=26.
import { Readable, Writable } from "node:stream"
import { createInterface } from "node:readline"

import type { AgentEventEnvelope } from "@cognia/agent-config-types/agent-execution"
import type { AgentStructuredError } from "@cognia/agent-config-types/agent-run-result"

import type { CogniaRuntime, CogniaSession, SessionAnnotation } from "../runtime"
import { createCogniaRuntime, type CogniaRuntimeOptions } from "../runtime"
import type { AgentInput } from "../input"

import {
  isJsonRpcRequest,
  makeErrorResponse,
  makeNotification,
  makeSuccessResponse,
  RPC_ERROR_CODES,
  RPC_METHODS,
  RPC_PROTOCOL_VERSION,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type RpcMethod,
} from "./protocol"

export type { JsonRpcRequest, JsonRpcResponse, RpcMethod }
export { RPC_ERROR_CODES, RPC_METHODS, RPC_PROTOCOL_VERSION }

// ─── Server types ────────────────────────────────────────────────────────────

export interface RpcServerOptions {
  /** How to create the underlying runtime. */
  runtimeOptions: CogniaRuntimeOptions
  /** Input stream (default: process.stdin). */
  input?: Readable
  /** Output stream for JSON-RPC responses/notifications (default: process.stdout). */
  output?: Writable
  /** Diagnostic stream (default: process.stderr). */
  diagnostic?: Writable
  /** Injected runtime for testing. When provided, runtimeOptions are ignored. */
  runtime?: CogniaRuntime
}

export interface RpcServer {
  /** Start reading from the input stream. Resolves on EOF or shutdown. */
  serve(): Promise<void>
  /** Graceful shutdown — closes all sessions and stops reading. */
  shutdown(): void
}

// ─── Server implementation ───────────────────────────────────────────────────

export async function createRpcServer(options: RpcServerOptions): Promise<RpcServer> {
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  const diagnostic = options.diagnostic ?? process.stderr

  const runtime = options.runtime ?? (await createCogniaRuntime(options.runtimeOptions))

  const sessions = new Map<string, CogniaSession>()
  let shutdownRequested = false

  function log(level: "info" | "warn" | "error", message: string): void {
    const line = JSON.stringify({ level, message, ts: new Date().toISOString() })
    diagnostic.write(line + "\n")
  }

  function send(
    message: JsonRpcResponse | { jsonrpc: "2.0"; method: string; params?: Record<string, unknown> }
  ): void {
    output.write(JSON.stringify(message) + "\n")
  }

  function errorCodeFromStructured(err: AgentStructuredError): number {
    switch (err.code) {
      case "session_busy":
        return RPC_ERROR_CODES.sessionBusy
      case "session_not_found":
        return RPC_ERROR_CODES.sessionNotFound
      case "session_locked":
        return RPC_ERROR_CODES.sessionLocked
      case "config_error":
      case "usage_error":
        return RPC_ERROR_CODES.configError
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
      default:
        return RPC_ERROR_CODES.internalError
    }
  }

  async function dispatch(req: JsonRpcRequest): Promise<void> {
    const method = req.method as RpcMethod
    const params = (req.params ?? {}) as Record<string, unknown>

    if (!RPC_METHODS.includes(method)) {
      send(makeErrorResponse(req.id, RPC_ERROR_CODES.methodNotFound, `unknown method: ${method}`))
      return
    }

    try {
      const result = await handleMethod(method, params, req.id)
      send(makeSuccessResponse(req.id, result))
    } catch (err) {
      const structured = (err as { structuredError?: AgentStructuredError }).structuredError
      if (structured) {
        send(
          makeErrorResponse(
            req.id,
            errorCodeFromStructured(structured),
            structured.message,
            structured
          )
        )
      } else {
        const message = err instanceof Error ? err.message : String(err)
        send(makeErrorResponse(req.id, RPC_ERROR_CODES.internalError, message))
      }
    }
  }

  async function handleMethod(
    method: RpcMethod,
    params: Record<string, unknown>,
    _id: string | number
  ): Promise<unknown> {
    switch (method) {
      case "runtime.discover":
        return {
          protocolVersion: RPC_PROTOCOL_VERSION,
          methods: RPC_METHODS,
          capabilities: [],
        }

      case "runtime.shutdown":
        shutdownRequested = true
        runtime.dispose()
        return { ok: true }

      case "runtime.models":
        // Delegate to the config's known models list
        return { models: [] }

      case "session.create": {
        const session = await runtime.createSession({
          name: typeof params.name === "string" ? params.name : undefined,
          cwd: typeof params.cwd === "string" ? params.cwd : undefined,
        })
        sessions.set(session.sessionId, session)
        return { sessionId: session.sessionId }
      }

      case "session.open": {
        const sessionId = requireString(params, "sessionId")
        const session = await runtime.createSession({ sessionId })
        sessions.set(session.sessionId, session)
        return { sessionId: session.sessionId }
      }

      case "session.list":
        return { sessions: runtime.listSessions() }

      case "session.state": {
        const session = requireSession(params)
        return session.state()
      }

      case "session.messages": {
        const session = requireSession(params)
        return { messages: session.messages() }
      }

      case "session.entries": {
        const session = requireSession(params)
        return { entries: session.entries() }
      }

      case "session.stats": {
        const session = requireSession(params)
        const state = session.state()
        return { turnCount: state.turnCount, usage: state.usage }
      }

      case "session.export": {
        const session = requireSession(params)
        return { messages: session.messages(), entries: session.entries() }
      }

      case "session.name": {
        const session = requireSession(params)
        const name = requireString(params, "name")
        session.setName(name)
        return { ok: true }
      }

      case "session.annotation": {
        const session = requireSession(params)
        const annotation: SessionAnnotation = {
          type: requireString(params, "type"),
          summary: requireString(params, "summary"),
          ...(params.data !== undefined ? { data: params.data } : {}),
        }
        session.appendAnnotation(annotation)
        return { ok: true }
      }

      case "session.close": {
        const sessionId = requireString(params, "sessionId")
        const session = sessions.get(sessionId)
        if (session) {
          session.close()
          sessions.delete(sessionId)
        }
        return { ok: true }
      }

      case "turn.run": {
        const session = requireSession(params)
        const input: AgentInput =
          typeof params.prompt === "string" ? params.prompt : ((params.input as AgentInput) ?? "")
        const result = await session.run(input, {
          onEnvelope: (envelope: AgentEventEnvelope) => {
            send(
              makeNotification("agent.event", {
                sessionId: session.sessionId,
                envelope: envelope as unknown as Record<string, unknown>,
              })
            )
          },
          ...(typeof params.timeoutMs === "number" ? { timeoutMs: params.timeoutMs } : {}),
          ...(typeof params.idleTimeoutMs === "number"
            ? { idleTimeoutMs: params.idleTimeoutMs }
            : {}),
          ...(typeof params.maxSteps === "number" ? { maxSteps: params.maxSteps } : {}),
          ...(params.includeDiagnostics === true ? { includeDiagnostics: true } : {}),
        })
        return result
      }

      case "turn.steer": {
        const session = requireSession(params)
        const instruction = requireString(params, "instruction")
        await session.steer(instruction)
        return { ok: true }
      }

      case "turn.followUp": {
        // follow-up is just another run on the same session
        const session = requireSession(params)
        const input: AgentInput =
          typeof params.prompt === "string" ? params.prompt : ((params.input as AgentInput) ?? "")
        const result = await session.run(input, {
          onEnvelope: (envelope: AgentEventEnvelope) => {
            send(
              makeNotification("agent.event", {
                sessionId: session.sessionId,
                envelope: envelope as unknown as Record<string, unknown>,
              })
            )
          },
        })
        return result
      }

      case "turn.abort": {
        const session = requireSession(params)
        await session.abort()
        return { ok: true }
      }

      // Stub methods that pass through to session operations
      case "session.model":
      case "session.thinking":
      case "session.compact":
      case "session.undoCompact":
      case "session.fork":
      case "session.clone":
      case "session.tree":
      case "permission.respond":
      case "elicitation.respond":
        return { ok: true, stub: true }

      default:
        throw Object.assign(new Error(`not implemented: ${method}`), {
          structuredError: { code: "usage_error" as const, message: `not implemented: ${method}` },
        })
    }
  }

  function requireString(params: Record<string, unknown>, key: string): string {
    const value = params[key]
    if (typeof value !== "string" || value.length === 0) {
      throw Object.assign(new Error(`${key} must be a non-empty string`), {
        structuredError: {
          code: "usage_error" as const,
          message: `${key} must be a non-empty string`,
          detail: { param: key },
        },
      })
    }
    return value
  }

  function requireSession(params: Record<string, unknown>): CogniaSession {
    const sessionId = requireString(params, "sessionId")
    const session = sessions.get(sessionId)
    if (!session) {
      throw Object.assign(new Error(`session not found: ${sessionId}`), {
        structuredError: {
          code: "session_not_found" as const,
          message: `session not found: ${sessionId}`,
          detail: { sessionId },
        },
      })
    }
    return session
  }

  function shutdown(): void {
    shutdownRequested = true
    for (const session of sessions.values()) {
      session.close()
    }
    sessions.clear()
    runtime.dispose()
  }

  async function serve(): Promise<void> {
    log("info", `cognia-agent rpc v${RPC_PROTOCOL_VERSION} ready`)

    const rl = createInterface({ input, crlfDelay: Infinity })

    for await (const line of rl) {
      if (shutdownRequested) break
      if (line.trim().length === 0) continue

      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        send(makeErrorResponse(0, RPC_ERROR_CODES.parseError, "invalid JSON"))
        continue
      }

      if (!isJsonRpcRequest(parsed)) {
        send(
          makeErrorResponse(0, RPC_ERROR_CODES.invalidRequest, "not a valid JSON-RPC 2.0 request")
        )
        continue
      }

      // Dispatch concurrently — the session-level busy guard handles contention.
      void dispatch(parsed)
    }

    // EOF reached — clean up
    if (!shutdownRequested) {
      shutdown()
    }
  }

  return { serve, shutdown }
}
