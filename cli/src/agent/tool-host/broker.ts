/**
 * Session-scoped Cognia tool-host broker.
 *
 * Owns everything the external agent must not: session identity, the effective
 * tool manifest, workspace confinement, the approval overlay, host/plugin
 * execution, and cancellation. The MCP bridge the agent spawns holds only a
 * short-lived token and a socket to here.
 *
 * Lifetime is exactly one connected external backend attempt. A bridge that
 * outlives its attempt — a stale process from a backend the user switched away
 * from, or one restarted after a context-version change — authenticates against
 * an `attempt` that no longer matches and is refused, so it cannot execute a
 * tool on a session it no longer belongs to.
 */

import net from "node:net"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { randomBytes } from "node:crypto"

import type { PermissionRequestEvent } from "@cognia/agent-config-types"
import type { CapturePermissionDecision } from "@/lib/claude/run-and-capture"
import type { PluginToolManifestEntry } from "@/lib/plugin/bridge/sidecar-tools-bridge"

import type { ResolvedCliSessionContext } from "../session-context"
import type { PermissionResponder } from "../permission-gate"
import {
  decodeLines,
  encodeLine,
  COGNIA_PLUGIN_TOOLS_SERVER,
  COGNIA_TOOLS_SERVER,
  type AuthorizeParams,
  type AuthorizeResult,
  type ExecParams,
  type ExecResult,
  type HelloParams,
  type ReportParams,
  type ToolHostRequest,
  type ToolHostServerName,
  type ToolHostSessionDescriptor,
} from "./protocol"
import {
  checkConfinement,
  confinementRoots,
  namespacedHostTool,
  needsApproval,
  visibleBuiltinTools,
  visibleHostTools,
} from "./policy"
import { namespaced } from "@/lib/settings/builtin-tools"

/** A tool call that reached the broker, for the TUI's own rendering. */
export interface ToolHostCallEvent {
  server: ToolHostServerName
  name: string
  input: unknown
  /** Stable id so a later result can be matched to this call. */
  callKey: string
}

export interface ToolHostResultEvent {
  callKey: string
  name: string
  ok: boolean
  summary?: string
}

export interface ToolHostBrokerParams {
  session: ResolvedCliSessionContext
  /**
   * Monotonic connect-attempt id. A bridge minted for attempt N is refused once
   * the broker has moved on, which is what makes a rapid backend switch safe.
   */
  attempt: number
  /** Cognia's approval overlay. Absent ⇒ every approval-needing call is denied. */
  gate?: PermissionResponder
  /** Execute one `cognia-plugin-tools` call through the existing CLI executors. */
  execHostTool: (name: string, args: unknown) => Promise<ExecResult>
  /** Surface a projected tool call in the TUI, like a built-in one. */
  onToolCall?: (event: ToolHostCallEvent) => void
  onToolResult?: (event: ToolHostResultEvent) => void
  /** Socket directory. Defaults to a private dir under the OS temp root. */
  socketDir?: string
  /** Injected for tests. */
  mintToken?: () => string
}

export interface ToolHostBroker {
  /** Absolute socket path (POSIX) or pipe name (Windows). */
  readonly endpoint: string
  /** Bearer token the bridge must present. Never logged, never in argv. */
  readonly token: string
  readonly attempt: number
  /** How many bridges are currently connected — surfaced by `/doctor`. */
  connections(): number
  /** True once `close()` ran. */
  isClosed(): boolean
  /** Reject every in-flight call and stop accepting new ones. */
  cancelInFlight(reason: string): void
  /** Full teardown: stop listening, drop connections, unlink the socket. */
  close(): Promise<void>
}

/**
 * Longest session-id fragment allowed in a socket file name.
 *
 * A unix socket path must fit `sun_path` (~104 bytes), and the macOS temp dir is
 * already ~48 of them. A long session id would push the whole path over and
 * `listen` fails with EINVAL — a failure that reads as "the tool host is broken"
 * rather than "the name was too long". Uniqueness still comes from the attempt
 * and pid, so truncating the id costs nothing.
 */
const MAX_ENDPOINT_SESSION_CHARS = 16

/** A pipe name on Windows; a short socket path under the temp dir elsewhere. */
export function toolHostEndpoint(sessionId: string, attempt: number, dir?: string): string {
  const safeId = sessionId.replace(/[^A-Za-z0-9_-]/g, "").slice(-MAX_ENDPOINT_SESSION_CHARS)
  const token = `${safeId}-${attempt}`
  if (process.platform === "win32") {
    // Named pipes have no such limit, so the full (sanitised) id stays.
    return `\\\\.\\pipe\\cognia-toolhost-${token}-${process.pid}`
  }
  return path.join(dir ?? os.tmpdir(), `cognia-th-${token}-${process.pid}.sock`)
}

/** Namespaced name for the audit/approval surfaces, per server. */
function namespacedFor(server: ToolHostServerName, name: string): string {
  return server === COGNIA_TOOLS_SERVER ? namespaced(name) : namespacedHostTool(name)
}

/** Compact one-line preview of a tool result, for the TUI cell. */
function summarize(value: unknown, limit = 400): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null)
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

export async function startToolHostBroker(params: ToolHostBrokerParams): Promise<ToolHostBroker> {
  const { session, attempt } = params
  const token = (params.mintToken ?? (() => randomBytes(32).toString("base64url")))()
  const endpoint = toolHostEndpoint(session.sessionId, attempt, params.socketDir)
  const visibleBuiltins = new Set(visibleBuiltinTools(session.sendOptions))
  const visibleHost = new Set(visibleHostTools(session.sendOptions))
  const roots = confinementRoots(session)
  // `SendOptions.pluginTools` is typed without the per-entry `timeoutMs` the
  // manifest builder actually sets (`PluginToolManifestEntry`), and human-blocking
  // tools depend on it being forwarded — `ask_user` must NOT inherit a relay
  // timeout, or a slow answer severs a perfectly valid call.
  const hostToolsByName = new Map(
    ((session.sendOptions.pluginTools ?? []) as PluginToolManifestEntry[]).map(
      (entry) => [entry.name, entry] as const
    )
  )

  const descriptor: ToolHostSessionDescriptor = {
    sessionId: session.sessionId,
    attempt,
    contextVersion: session.contextVersion,
    cwd: session.cwd,
    additionalDirectories: session.additionalDirectories,
    enabledCategories: (session.sendOptions.builtinTools ?? {}) as Record<string, boolean>,
    visibleBuiltinTools: [...visibleBuiltins],
    hostTools: [...visibleHost].map((name) => {
      const entry = hostToolsByName.get(name)
      return {
        name,
        description: entry?.description ?? "",
        jsonSchema: entry?.jsonSchema ?? { type: "object", properties: {} },
        ...(typeof entry?.timeoutMs === "number" ? { timeoutMs: entry.timeoutMs } : {}),
      }
    }),
    model: session.sendOptions.model ?? "",
    provider: session.sendOptions.provider ?? "",
    ...(session.sendOptions.toolExecutionTimeoutMs !== undefined
      ? { toolExecutionTimeoutMs: session.sendOptions.toolExecutionTimeoutMs }
      : {}),
    // The tool-result cap lives on the compaction settings, exactly where the
    // sidecar dispatchers read it from.
    ...(session.sendOptions.compaction?.maxToolResultTokens !== undefined
      ? { maxToolResultTokens: session.sendOptions.compaction.maxToolResultTokens }
      : {}),
    ...(session.sendOptions.lsp ? { lsp: session.sendOptions.lsp } : {}),
    ...((session.sendOptions as { codeGraph?: unknown }).codeGraph
      ? { codeGraph: (session.sendOptions as { codeGraph?: unknown }).codeGraph }
      : {}),
  }

  const sockets = new Set<net.Socket>()
  let closed = false
  let cancelledReason: string | null = null
  let callSeq = 0

  /** Decide one call. Never throws — a fault reads as a denial, not a crash. */
  async function authorize(
    server: ToolHostServerName,
    p: AuthorizeParams
  ): Promise<AuthorizeResult> {
    if (closed) return { allow: false, reason: "the Cognia session has ended" }
    if (cancelledReason) return { allow: false, reason: cancelledReason }
    const visible = server === COGNIA_TOOLS_SERVER ? visibleBuiltins : visibleHost
    // A name filtered out of discovery is denied here too, so a model that
    // guessed a disabled tool's name gets a refusal rather than an execution.
    if (!visible.has(p.name)) {
      return { allow: false, reason: `"${p.name}" is not available in this session` }
    }
    const confined = checkConfinement(roots, session.cwd, p.args)
    // `checkConfinement` always explains a denial, so the reason is never absent.
    if (!confined.allowed) return { allow: false, reason: String(confined.reason) }
    const full = namespacedFor(server, p.name)
    if (!needsApproval(session.sendOptions, full)) return { allow: true }
    if (!params.gate) {
      return { allow: false, reason: `"${p.name}" needs approval and none is available` }
    }
    const request: PermissionRequestEvent = {
      type: "permission_request",
      sessionId: session.sessionId,
      requestId: `toolhost-${++callSeq}`,
      toolUseID: `toolhost-${callSeq}`,
      toolName: full,
      displayName: full,
      input: (p.args ?? {}) as Record<string, unknown>,
    }
    let decision: CapturePermissionDecision
    try {
      decision = await params.gate(request)
    } catch {
      return { allow: false, reason: `"${p.name}" was denied` }
    }
    if (decision.decision === "deny") {
      return { allow: false, reason: decision.message ?? `"${p.name}" was denied` }
    }
    return { allow: true }
  }

  function handle(socket: net.Socket, server: { name: ToolHostServerName | null }) {
    let buffer = ""
    socket.setEncoding("utf8")
    socket.on("data", (chunk: string) => {
      buffer += chunk
      const { messages, rest } = decodeLines(buffer)
      buffer = rest
      for (const message of messages) {
        if (message === null) {
          socket.destroy()
          return
        }
        void dispatch(socket, server, message as ToolHostRequest)
      }
    })
    socket.on("error", () => socket.destroy())
    socket.on("close", () => sockets.delete(socket))
  }

  async function dispatch(
    socket: net.Socket,
    state: { name: ToolHostServerName | null },
    request: ToolHostRequest
  ): Promise<void> {
    const reply = (body: { result?: unknown; error?: string }) => {
      if (!socket.destroyed) socket.write(encodeLine({ id: request.id, ...body }))
    }
    // Every method except `hello` requires an authenticated connection, so a
    // bridge that skipped the handshake can never reach the executors.
    if (request.method === "hello") {
      const p = (request.params ?? {}) as HelloParams
      if (p.token !== token) {
        reply({ error: "unauthorized" })
        socket.destroy()
        return
      }
      if (p.server !== COGNIA_TOOLS_SERVER && p.server !== COGNIA_PLUGIN_TOOLS_SERVER) {
        reply({ error: "unknown server" })
        socket.destroy()
        return
      }
      state.name = p.server
      reply({ result: { session: descriptor } })
      return
    }
    if (!state.name) {
      reply({ error: "unauthorized" })
      socket.destroy()
      return
    }
    switch (request.method) {
      case "authorize": {
        reply({ result: await authorize(state.name, (request.params ?? {}) as AuthorizeParams) })
        return
      }
      case "exec": {
        const p = (request.params ?? {}) as ExecParams
        // `exec` is only for broker-owned host tools; a bridge asking us to run
        // a built-in would be trying to move execution across the trust line.
        if (state.name !== COGNIA_PLUGIN_TOOLS_SERVER) {
          reply({ result: { error: "exec is not available on this server" } })
          return
        }
        const verdict = await authorize(state.name, { name: p.name, args: p.args })
        if (!verdict.allow) {
          reply({ result: { error: verdict.reason } })
          return
        }
        const callKey = `toolhost-${++callSeq}`
        params.onToolCall?.({
          server: state.name,
          name: p.name,
          input: p.args,
          callKey,
        })
        let outcome: ExecResult
        try {
          outcome = await params.execHostTool(p.name, p.args)
        } catch (err) {
          outcome = { error: err instanceof Error ? err.message : String(err) }
        }
        params.onToolResult?.({
          callKey,
          name: p.name,
          ok: !outcome.error,
          summary: summarize(outcome.error ?? outcome.result),
        })
        reply({ result: outcome })
        return
      }
      case "report": {
        const p = (request.params ?? {}) as ReportParams
        const callKey = `toolhost-${++callSeq}`
        params.onToolCall?.({ server: state.name, name: p.name, input: {}, callKey })
        params.onToolResult?.({
          callKey,
          name: p.name,
          ok: p.ok,
          ...(p.summary ? { summary: p.summary } : {}),
        })
        reply({ result: {} })
        return
      }
      default:
        reply({ error: `unknown method: ${String(request.method)}` })
    }
  }

  const server = net.createServer((socket) => {
    if (closed) {
      socket.destroy()
      return
    }
    sockets.add(socket)
    handle(socket, { name: null })
  })

  // A leftover socket file from a crashed run would make `listen` fail with
  // EADDRINUSE; the path is process- and attempt-scoped, so removing it is safe.
  if (process.platform !== "win32") {
    try {
      fs.rmSync(endpoint, { force: true })
    } catch {
      // best-effort
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(endpoint, () => {
      server.removeListener("error", reject)
      resolve()
    })
  })

  // Owner-only: the socket is a capability, so no other local user may dial it.
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(endpoint, 0o600)
    } catch {
      // best-effort — an unsupported filesystem still has the token gate.
    }
  }

  return {
    endpoint,
    token,
    attempt,
    connections: () => sockets.size,
    isClosed: () => closed,
    cancelInFlight(reason: string) {
      cancelledReason = reason
    },
    async close() {
      if (closed) return
      closed = true
      cancelledReason = "the Cognia session has ended"
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      if (process.platform !== "win32") {
        try {
          fs.rmSync(endpoint, { force: true })
        } catch {
          // best-effort
        }
      }
    },
  }
}
