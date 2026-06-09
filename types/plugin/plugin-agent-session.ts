/**
 * Plugin Agent SDK — persistent multi-turn sessions (ADR-0026 §Agent-SDK,
 * Package D).
 *
 * A session is a durable `ChatSession` a plugin owns: each `send` runs a turn
 * that resumes the prior conversation (native SDK resume on the sidecar; a
 * replayed transcript on the text channel). `history` reads past turns; `end`
 * deletes the session. Resume across reload works because the SDK session id is
 * persisted on the row.
 *
 * Dependency-free leaf. Runtime in `lib/plugin/agent-sdk/session.ts`.
 */

import type { PluginAgentOutputFormat } from "./plugin-agent-sdk"

/** Options for creating a session. */
export interface PluginCreateSessionOptions {
  title?: string
  /** Reuse an existing persona (model / tools / skills / MCP) for every turn. */
  characterId?: string
  /** Absolute working directory for tool-enabled turns. */
  cwd?: string
}

/** Per-turn options for {@link PluginAgentSession.send}. */
export interface PluginSessionSendOptions {
  /** Run with the tool-enabled sidecar loop (default true). Degrades to text. */
  toolsEnabled?: boolean
  model?: string
  appendSystem?: string
  allowedTools?: string[]
  outputFormat?: PluginAgentOutputFormat
  abortSignal?: AbortSignal
}

/** Result of a session turn. */
export interface PluginSessionSendResult {
  text: string
  channel: "sidecar" | "text"
  toolsAvailable: boolean
  object?: unknown
  parseError?: string
}

/** A single past turn in a session's history. */
export interface PluginSessionMessage {
  role: "user" | "assistant" | "system"
  content: string
}

/** A live, durable plugin-owned agent session. */
export interface PluginAgentSession {
  /** The underlying ChatSession id (stable across reload for resume). */
  readonly id: string
  /** Run one turn that resumes the prior conversation. */
  send: (prompt: string, options?: PluginSessionSendOptions) => Promise<PluginSessionSendResult>
  /** Read the persisted conversation history. */
  history: () => Promise<PluginSessionMessage[]>
  /** Delete the session and its messages. */
  end: () => Promise<void>
}

/** Plugin-facing session surface (`ctx.agent.sessions`). */
export interface PluginAgentSessionsAPI {
  /** Create a new durable session. */
  create: (options?: PluginCreateSessionOptions) => Promise<PluginAgentSession>
  /** Resume an existing session by id (e.g. after reload). */
  resume: (sessionId: string) => Promise<PluginAgentSession>
}
