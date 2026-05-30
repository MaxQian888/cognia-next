// Compatibility shims for the ported Cognia plugin type surface.
//
// Cognia's plugin types reference subsystems cognia-next does not (yet)
// expose — `Project`, `KnowledgeFile`, the full `Session` SDK shape, and
// the `ChatMode` enum among them. Rather than diluting the Cognia type
// signatures (which need to stay shape-compatible so plugin authors can
// share code between Cognia and cognia-next), this file provides the
// minimum stub types so the contracts compile.
//
// Each stub is an opaque object with a marker brand. As cognia-next grows
// these subsystems for real, this file is the single point that needs to
// change — the plugin types stay frozen.

import type { ChatSession, StoredMessage, Skill } from "@/lib/claude/types"

// =============================================================================
// Session — cognia-next ships `ChatSession`; map it for plugin consumers
// =============================================================================

/**
 * Plugin-facing chat mode. Cognia distinguishes "chat" / "agent" / "plan";
 * cognia-next carries the same concept implicitly through agent modes.
 * We accept the literal union and any string so plugin code can still use
 * `mode` for filtering even if the surface eventually grows new modes.
 */
export type ChatMode = "chat" | "agent" | "plan" | (string & {})

/**
 * A single conversation branch — a divergence point in a session created
 * by re-rolling an assistant message. The plugin Session API surfaces
 * branches per-session so authors can build UI on top.
 */
export interface SessionBranch {
  id: string
  parentMessageId?: string
  createdAt: Date | number
}

/**
 * Plugin-facing chat session — extends cognia-next's `ChatSession` with
 * the optional fields plugin authors expect (mode, projectId, branches).
 * `createdAt` / `updatedAt` are widened to accept either number or Date
 * because plugin authors typically work with `Date` while cognia-next
 * persists ms-since-epoch numbers; the runtime accepts both.
 * All extras are optional so the plugin runtime can populate them where
 * relevant without breaking writers that don't.
 */
export type Session = Omit<ChatSession, "createdAt" | "updatedAt"> & {
  createdAt: number | Date
  updatedAt: number | Date
  mode?: ChatMode
  projectId?: string
  branches?: SessionBranch[]
  /**
   * Provider id the session is currently routed to (e.g. "openai",
   * "anthropic"). Optional because cognia-next defaults to
   * Anthropic-via-sidecar, but plugins may surface multi-provider
   * sessions where this needs to be explicit.
   */
  provider?: string
}

export interface CreateSessionInput {
  title?: string
  characterId?: string
  teamId?: string
  /** Optional starting mode for the session. */
  mode?: ChatMode
  /** Project to attach the session to on create. */
  projectId?: string
  metadata?: Record<string, unknown>
}

export interface UpdateSessionInput {
  title?: string
  mode?: ChatMode
  projectId?: string
  metadata?: Record<string, unknown>
}

/**
 * Plugin-facing message attachment shape. Mirrors the `MessageAttachment`
 * defined in `plugin-extended.ts`; we declare it here for use inside
 * the `UIMessage` extension below without creating a cyclic import.
 */
export interface PluginMessageAttachment {
  id?: string
  type: "file" | "image" | "code" | "url"
  name: string
  content?: string
  url?: string
  mimeType?: string
  size?: number
}

export interface MessageTokenStats {
  total?: number
  input?: number
  output?: number
  /** Alias for `input` used by some plugin authors. */
  prompt?: number
  /** Alias for `output` used by some plugin authors. */
  completion?: number
}

/**
 * Plugin-facing message — alias over cognia-next's `StoredMessage` with
 * convenience fields the plugin API surfaces (content / attachments /
 * tokens). The cognia-next core stores message text inside `parts`; the
 * plugin runtime materialises it into `content` for plugin authors who
 * want a single string. Both forms are optional so the plugin runtime
 * can populate them lazily.
 *
 * `createdAt` is widened to `Date | number` for the same reason as
 * `Session.createdAt` — plugin authors prefer `Date`. `parts` and
 * `sessionId` are made optional so plugin code can construct messages
 * with just `content`; the persistence layer fills in the rest.
 */
export type UIMessage = Omit<StoredMessage, "createdAt" | "parts" | "sessionId"> & {
  createdAt: number | Date
  parts?: StoredMessage["parts"]
  sessionId?: string
  content?: string
  attachments?: PluginMessageAttachment[]
  tokens?: MessageTokenStats
  branchId?: string
}

// =============================================================================
// Project — cognia-next exposes the canonical Project shape here so the
// plugin Project API and the application share a single definition. The
// top-level `@/types` barrel re-exports these names; do NOT redeclare
// `Project` or `KnowledgeFile` upstream.
// =============================================================================

export interface KnowledgeFile {
  id: string
  name: string
  type:
    | "text"
    | "pdf"
    | "code"
    | "markdown"
    | "json"
    | "word"
    | "excel"
    | "csv"
    | "html"
    | "presentation"
    | "rtf"
    | "epub"
  content: string
  size: number
  mimeType?: string
  originalSize?: number
  pageCount?: number
  createdAt: Date
  updatedAt: Date
}

export interface Project {
  id: string
  name: string
  description?: string
  rootDir?: string
  /**
   * Extra absolute directories mounted into this workspace alongside `rootDir`.
   * Forwarded to the SDK as `additionalDirectories` so Read/Glob/Edit can reach
   * them without an @-reference. Plain absolute paths — same shape the SDK's
   * `SendOptions.additionalDirectories` expects.
   */
  additionalDirs?: string[]
  customInstructions?: string
  knowledgeBase: KnowledgeFile[]
  sessionIds: string[]
  sessionCount: number
  messageCount: number
  tags?: string[]
  isArchived?: boolean
  createdAt: Date
  updatedAt: Date
  lastAccessedAt: Date
  metadata?: Record<string, unknown>
  /**
   * Per-project override for the integrated terminal dock (ADR plan
   * `vscode-vivid-wilkinson.md`). When set, the dock's "+ New" affordance
   * uses these fields instead of the global settings defaults.
   *
   *   * `shell` — absolute path or PATH-resolvable shell binary
   *   * `cwd` — initial cwd (falls back to `rootDir`, then `$HOME`)
   *   * `env` — extra env vars to layer on top of the inherited env
   */
  terminalConfig?: {
    shell?: string
    cwd?: string
    env?: Record<string, string>
  }
}

export interface CreateProjectInput {
  name: string
  description?: string
  systemPrompt?: string
  tags?: string[]
  rootDir?: string
  additionalDirs?: string[]
  metadata?: Record<string, unknown>
}

export interface UpdateProjectInput {
  name?: string
  description?: string
  customInstructions?: string
  rootDir?: string
  additionalDirs?: string[]
  tags?: string[]
  isArchived?: boolean
  metadata?: Record<string, unknown>
}

// =============================================================================
// Skill — cognia-next ships its own `Skill`; re-export so plugin types resolve
// =============================================================================

export type { Skill }
