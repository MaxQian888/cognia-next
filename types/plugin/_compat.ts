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

import type { ChatSession, StoredMessage, Skill } from "@cognia/agent-config-types"
import type { WorkspaceRoot } from "@/types/workspace"

// Workspace roots are owned by `types/workspace`; re-export so the plugin
// Project surface resolves `WorkspaceRoot` from this single _compat module.
export type { WorkspaceRoot }

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
  /**
   * The Squad this conversation is handed to (ADR-0140), or `undefined` to
   * hand it back to the direct path. Readable all along, because `getSession`
   * returns the stored row, but this whitelist is what `updateSession` accepts,
   * so a plugin could see the binding and not change it.
   */
  squadId?: ChatSession["squadId"]
}

/**
 * Plugin-facing message attachment shape. Mirrors the `MessageAttachment`
 * defined in `plugin.ts`; we declare it here for use inside
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
  /** Pinned projects sort before recent projects in fast-entry surfaces. */
  pinned?: boolean
  /** Project-local environment selected for new chats and managed worktrees. */
  defaultEnvironmentId?: string
  /** Device-local default remembered by the new-chat Local/Worktree selector. */
  defaultExecutionLocation?: "local" | "managedWorktree"
  description?: string
  /**
   * Mounted directories of this workspace. Single source of truth for the cwd
   * (primary root) and additionalDirectories (the rest). `rootDir` /
   * `additionalDirs` below are derived mirrors kept in sync on every mutation
   * for the plugin API contract — never write them directly; read via the
   * `lib/workspace/roots` helpers.
   */
  roots: WorkspaceRoot[]
  /** @deprecated derived mirror of the primary root's path. Read via `primaryRootOf(project)`. */
  rootDir?: string
  /**
   * @deprecated derived mirror of the non-primary root paths. Read via
   * `additionalDirsOf(project)`. Forwarded to the SDK as `additionalDirectories`.
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
  /**
   * Per-project knowledge-base / RAG settings (project-scoped RAG, ADR project
   * knowledge). Structural mirror of `ProjectKnowledgeSettings` in
   * `@/types/project-knowledge` — kept inline here to avoid a types import cycle
   * (`@/types/project-knowledge` → `@/types/twin` → barrel). All fields optional;
   * read via `resolveProjectKnowledgeSettings`.
   */
  knowledgeSettings?: {
    enableProjectRag?: boolean
    ragTopK?: number
  }
  /**
   * Per-workspace enablement deltas for globally-defined capabilities —
   * capability id -> `true` (on here) / `false` (off here); absent inherits the
   * definition's own flag. Structural mirror of `WorkspaceCapabilityOverlay`
   * (`@/lib/workspace/capability-overlay`), kept inline here for the same
   * reason `knowledgeSettings` is: this module must not import from `lib/`.
   *
   * Read through `resolveCapabilityEnabled` / `applyCapabilityOverlay`, never
   * by indexing directly — the resolver is what makes a malformed bucket read
   * as "no opinion" instead of throwing inside a send path. Plugins are
   * deliberately absent; see that module's header for why.
   */
  capabilityOverlay?: {
    skill?: Record<string, boolean>
    mcpServer?: Record<string, boolean>
  }
  /**
   * Worktree provisioning this device accepted for this workspace — cache
   * directories to link and gitignored files to copy into a managed worktree.
   *
   * Device-local on purpose. A cache link points a worktree at a directory
   * inside this checkout, so accepting one is a decision about THIS machine's
   * disk; syncing it to another device would apply a consent that device never
   * gave. It is also deliberately not folded into the repository declaration
   * (`.cognia/workspace.json`): that gate's prompt says "the repository asks
   * for this", and a guess of ours must not borrow those words.
   *
   * `reviewed` holds every candidate already decided, accepted or not, so a
   * declined proposal is not re-offered on the next render. Structural mirror
   * of `ProvisioningConsent` (`@/lib/workspace/provisioning-inference`), kept
   * inline for the same reason `knowledgeSettings` is: this module must not
   * import from `lib/`.
   */
  workspaceProvisioning?: {
    accepted: string[]
    reviewed: string[]
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
