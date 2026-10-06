/**
 * Host ports an integration uses to reach the machine (ADR-0217).
 *
 * Integration packages never import a host: the desktop app implements these
 * over its Tauri/companion transport, the CLI over its Node backend, the
 * headless brain over the companion process plane. The host — not the
 * integration — applies the spawn allowlist, the sandbox, placement and audit,
 * so declaring a need here grants nothing.
 */

import type { ExternalAgentConfig } from "./external-agent"

/** Release a subscription. Idempotent. */
export type Unsubscribe = () => void

/** One child process an adapter asks the host to start. */
export interface AgentProcessSpawnSpec {
  /**
   * Process id chosen by the adapter. Adapters own their ids (the config id
   * for a connection, `<configId>:<suffix>` for per-session children) so the
   * host can attach run placement and track them.
   */
  id: string
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  /**
   * `line` (default) delivers stripped stdout lines; `raw` delivers undecoded
   * base64 chunks for adapters that own a strict byte framing.
   */
  framing?: "line" | "raw"
}

export interface AgentProcessOutputEvent {
  processId: string
  /** A stdout line (`line` framing), a base64 chunk (`raw`), or stderr text. */
  data: string
}

export interface AgentProcessExitEvent {
  processId: string
  code: number
  signal?: string | null
}

/**
 * Child-process plane. Subscriptions are host-wide; listeners filter by
 * `processId`, matching how every host already multiplexes agent output.
 */
export interface AgentProcessHost {
  /** False when this host cannot run agent processes at all (web, locked mobile). */
  readonly available: boolean
  /**
   * Start a child. Resolves with the id the host registered it under: the
   * requested `spec.id` on every current host, returned so an adapter never
   * assumes it.
   */
  spawn(spec: AgentProcessSpawnSpec): Promise<string>
  /** Write one framed message to the child's stdin. */
  send(processId: string, message: string): Promise<void>
  /** Bounded process-group termination and reaping. */
  kill(processId: string): Promise<void>
  /**
   * True when `command` (a bare executable name) resolves on this host. A
   * probe, not a grant: spawning it still passes the host's allowlist.
   */
  commandExists(command: string): Promise<boolean>
  onStdoutLine(listener: (event: AgentProcessOutputEvent) => void): Promise<Unsubscribe>
  onStdoutRaw(listener: (event: AgentProcessOutputEvent) => void): Promise<Unsubscribe>
  onStderr(listener: (event: AgentProcessOutputEvent) => void): Promise<Unsubscribe>
  onExit(listener: (event: AgentProcessExitEvent) => void): Promise<Unsubscribe>
}

/**
 * Workspace file plane. Every operation names the roots it may touch; the host
 * resolves the path against them and refuses traversal and symlink escapes, so
 * an integration cannot widen its reach by choosing a path. Paths are
 * absolute, in the host's own separator convention.
 */
export interface AgentFileHost {
  /** False when this host has no workspace file access (web). */
  readonly available: boolean
  /**
   * Lexical containment under the host's path semantics (separators, case
   * folding). Integrations use it to reject a path before handing it to an
   * agent process, which would otherwise open it outside this plane.
   */
  isWithinRoot(path: string, root: string): boolean
  readText(path: string, allowedRoots: readonly string[]): Promise<string>
  /** Creates missing parent directories inside the root. */
  writeText(path: string, content: string, allowedRoots: readonly string[]): Promise<void>
  /** Deletes one file. */
  delete(path: string, allowedRoots: readonly string[]): Promise<void>
}

/** What the host's agent fetch honours beyond `RequestInit`. */
export interface AgentFetchInit extends RequestInit {
  /** Bounds the response head only; a streamed body is unbounded. */
  connectTimeout?: number
  /** Maximum silence between body chunks (SSE keep-alive detection). */
  readTimeout?: number
  /** Refuse private, loopback and link-local targets. */
  blockPrivateHosts?: boolean
}

/**
 * The host's HTTP client for agents reached over the network (OpenCode
 * services, A2A peers, remote hosts). It routes through the host's transport,
 * proxy and network policy and streams response bodies, which a server-sent
 * event stream needs. Integrations never call a global `fetch`.
 */
export type AgentFetch = (input: Request | URL | string, init?: AgentFetchInit) => Promise<Response>

/**
 * The host's credential redactor for text an integration captured from a
 * process (stderr, error messages) before it is shown or stored. Not the
 * outbound PII gate: this rewrites diagnostics, the gate refuses sends.
 */
export type AgentDiagnosticRedactor = (text: string) => string

/**
 * Resolves the environment one configuration launches with: its own
 * credentials, state root and bound account (ADR-0216). Secrets never live in
 * the stored config; the host injects them here, immediately before spawn.
 */
export type AgentLaunchEnvironmentResolver = (
  config: ExternalAgentConfig,
  baseEnv: Record<string, string>
) => Promise<Record<string, string>>

/**
 * What a configuration's own approval lists (`requireApprovalFor`,
 * `autoApprovePatterns`) say about one permission request: `ask` forces a
 * prompt, `approve` answers it, `null` leaves it to the permission mode.
 */
export type AgentConfiguredApproval = "ask" | "approve" | null

/** The fields of a permission request the approval lists can match. */
export interface AgentApprovalPolicyRequest {
  title?: string
  kind?: string
  toolInfo?: { name?: string }
  rawInput?: Record<string, unknown>
}

/**
 * Host-owned approval policy. Integrations ask it; they never interpret the
 * configuration's lists themselves, so the matching rules stay in one place.
 */
export type AgentApprovalPolicy = (
  config: ExternalAgentConfig | undefined,
  request: AgentApprovalPolicyRequest
) => AgentConfiguredApproval

/**
 * The host's outbound privacy gate: `true` when `payload` may leave the
 * machine. Cognia passes its PII gate (`hasNoLeakingPiiDeep` from
 * `@cognia/redact`). Integrations call it on every prompt or payload they
 * send to an agent and refuse the send when it says no; it is a required
 * dependency, so no integration can be constructed without one.
 */
export type AgentOutboundGate = (payload: unknown) => boolean

/** Minimal structured logger an integration writes through. */
export interface AgentLogger {
  debug(message: string, data?: Record<string, unknown>): void
  info(message: string, data?: Record<string, unknown>): void
  warn(message: string, data?: Record<string, unknown>): void
  error(message: string, data?: Record<string, unknown>): void
}

/** A logger that drops everything; for integrations constructed without one. */
export const SILENT_AGENT_LOGGER: AgentLogger = Object.freeze({
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
})
