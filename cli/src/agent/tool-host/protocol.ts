/**
 * Wire contract between the Cognia tool-host broker (this process) and the MCP
 * bridge the external agent spawns.
 *
 * Deliberately NOT MCP: the bridge speaks MCP to the agent, and this private
 * channel to Cognia. Keeping them separate is what lets Cognia stay the security
 * authority — the agent can shape an MCP request, but it cannot shape a broker
 * request, forge a session id, or skip the authorize step, because it never
 * holds the token and never sees this socket.
 *
 * Framing is newline-delimited JSON: one request or response per line, ids
 * echoed back. A line that fails to parse closes the connection rather than
 * being guessed at.
 */

import os from "node:os"
import path from "node:path"

/** Which MCP server the bridge is impersonating. */
export type ToolHostServerName = "cognia-tools" | "cognia-plugin-tools"

export const COGNIA_TOOLS_SERVER: ToolHostServerName = "cognia-tools"
export const COGNIA_PLUGIN_TOOLS_SERVER: ToolHostServerName = "cognia-plugin-tools"

/** Env vars the bridge reads. Never argv — argv is world-readable via `ps`. */
export const TOOL_HOST_ENV = {
  socket: "COGNIA_TOOLHOST_SOCKET",
  token: "COGNIA_TOOLHOST_TOKEN",
  server: "COGNIA_TOOLHOST_SERVER",
} as const

/**
 * Narrow host directory exposed inside strict external-agent sandboxes. Linux
 * mounts `/tmp` as a private tmpfs, so a broker socket in the temp root is not
 * reachable; binding this dedicated directory keeps the rest of the host temp
 * tree hidden.
 */
export function toolHostRuntimeDir(tempRoot = os.tmpdir(), uid = process.getuid?.()): string {
  return path.join(tempRoot, `cognia-toolhost-${uid ?? "user"}`)
}

/** One tool the bridge should advertise but NOT execute (broker executes it). */
export interface HostToolDescriptor {
  name: string
  description: string
  /** JSON Schema for the tool input, as the manifest already carries it. */
  jsonSchema: unknown
  /** `0` (or absent) disables the relay timeout — human-blocking tools. */
  timeoutMs?: number
}

/**
 * The session facts the bridge needs to build an equivalent tool surface.
 *
 * Note what is NOT here: credentials, the system prompt, transcript, or any
 * approval state. The bridge is an executor of already-authorized calls, so it
 * is given the minimum that lets it construct schemas and run handlers.
 */
export interface ToolHostSessionDescriptor {
  /** Cognia chat session id — used only to reject a stale bridge. */
  sessionId: string
  /** Bumped on every connect attempt so a superseded bridge is refused. */
  attempt: number
  /** Fingerprint of the resolved context this bridge was minted for. */
  contextVersion: string
  cwd: string
  additionalDirectories: string[]
  /** `BuiltinToolsConfig` category toggles, verbatim. */
  enabledCategories: Record<string, boolean>
  /** Bare names the effective policy allows. Discovery is filtered to these. */
  visibleBuiltinTools: string[]
  /** The resolved `cognia-plugin-tools` manifest (broker-executed). */
  hostTools: HostToolDescriptor[]
  model: string
  provider: string
  /** Per-tool read-only execution deadline; `0` disables it. */
  toolExecutionTimeoutMs?: number
  /** Tool-result text cap, mirroring the sidecar's own result cap. */
  maxToolResultTokens?: number
  /**
   * Resolved LSP configuration, forwarded verbatim so the bridge can build the
   * SAME lazy resolver the sidecar dispatch paths do. Without it the `lsp`
   * category would advertise nothing on an external backend even when the user
   * enabled it — the "resolver-bound categories are silently missing" gap.
   */
  lsp?: unknown
  /** Code-graph knobs (watch mode). The root is derived from `cwd`. */
  codeGraph?: unknown
}

export interface HelloParams {
  token: string
  server: ToolHostServerName
}

export interface AuthorizeParams {
  /** Bare tool name (never the namespaced form — the broker namespaces it). */
  name: string
  args: unknown
}

export type AuthorizeResult = { allow: true } | { allow: false; reason: string }

export interface ExecParams {
  name: string
  args: unknown
}

export type ExecResult = { result?: unknown; error?: string }

export interface ReportParams {
  name: string
  ok: boolean
  /** Short, already-truncated preview for the TUI tool cell. */
  summary?: string
}

export type ToolHostMethod = "hello" | "authorize" | "exec" | "report"

export interface ToolHostRequest {
  id: number
  method: ToolHostMethod
  params?: unknown
}

export interface ToolHostResponse {
  id: number
  result?: unknown
  error?: string
}

/** Serialize one message as a single NDJSON line. */
export function encodeLine(message: ToolHostRequest | ToolHostResponse): string {
  return `${JSON.stringify(message)}\n`
}

/**
 * Split a growing buffer into complete lines.
 *
 * Returns the parsed messages plus the unconsumed remainder, so a caller can
 * hold partial frames across `data` events. A malformed line yields `null` in
 * `messages`; the caller decides (both sides drop the connection).
 */
export function decodeLines(buffer: string): {
  messages: (unknown | null)[]
  rest: string
} {
  // `split` always yields at least one element, so the trailing fragment is
  // never absent — even for an empty buffer.
  const parts = buffer.split("\n")
  const rest = parts.pop() as string
  const messages = parts
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as unknown
      } catch {
        return null
      }
    })
  return { messages, rest }
}
