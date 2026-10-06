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
import type { DocumentStructure } from "@cognia/document/types"
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
   * Free-form plugin annotations. Held on the cached row only: `ChatSession`
   * has no column for it, so `updateSession` applies it in memory and it is
   * gone on reload. Anything that has to survive belongs in the plugin's own
   * Dexie table (`ctx.dexie`) rather than here.
   */
  metadata?: Record<string, unknown>
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
  /**
   * Move the conversation to another Workspace, or `undefined` to unlink it.
   *
   * Not a plain column write: attribution also lives on the destination's
   * roster and on the session's own `executionContext`, so this rejects for a
   * running or handed-off conversation and for an unknown destination, the
   * same refusals the in-app move offers.
   */
  projectId?: string
  /** Free-form annotations. In-memory only, see {@link Session.metadata}. */
  metadata?: Record<string, unknown>
  /**
   * Per-turn reasoning effort forwarded to the active runtime.
   *
   * One setting in two halves with {@link UpdateSessionInput.thinkingLevel}.
   * Naming either one writes both: the store completes the missing half rather
   * than persisting a row that renders as one tier and sends another. Compose
   * `thinkingLevelPatch` and you never have to think about it.
   */
  effort?: ChatSession["effort"]
  /** Cognia's full thinking-tier identity, including off and ultracode. */
  thinkingLevel?: ChatSession["thinkingLevel"]
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
  /** Original text stays in content; this projection is only for embedding. */
  embeddableContent?: string
  structure?: DocumentStructure
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
  /**
   * Agent a person's new conversation in this workspace starts as, when they
   * did not pick one (`lib/workspace/project-default-agent.ts`). Point it at a
   * variant to give one repository its own configuration of a shared agent.
   * Automated conversation starts (`activate: false`) keep choosing their own.
   */
  defaultCharacterId?: string
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
  /**
   * Written as 0 at creation and never maintained; kept only for the persisted
   * row and plugin API shape. Count live via `countWorkspaceConversations(project.id)`
   * (`lib/db/sessions.ts`), as the workspace overview panel does.
   */
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
    retrievalStrategy?: "vector" | "hybrid" | "keyword"
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
   * The cogset this workspace runs (ADR-0209). Plugins are not overlaid per
   * workspace; instead, opening the workspace makes this cogset the effective
   * one, and the host reconciles to it through the plugin manager
   * (`lib/plugin/cogset/`). Absent means the workspace follows the global
   * cogset.
   */
  pluginCogsetId?: string
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
  /**
   * Project coordination (ADR-0204): one long-lived coordinator conversation
   * that starts worker threads. Absent = never enabled. Read through
   * `resolveCoordinatorConfig` (`lib/project-coordinator/config.ts`), which
   * owns the defaults. Budget and notification preferences deliberately live
   * in their own policies (`CostBudgetPolicy.perProject`,
   * `NotificationPreferences.perProject`), not here — one source of truth each.
   */
  coordinator?: ProjectCoordinatorConfig
}

/** Where a new project thread runs. `auto` = managed worktree iff the root is a git repo. */
export type ProjectThreadExecution = "auto" | "managedWorktree" | "local"

export interface ProjectCoordinatorModelChoice {
  /** Absent: the app's default model, with only the effort overridden. */
  modelId?: string
  /** Provider serving `modelId`; absent means the app's default provider. */
  providerId?: string
  effort?: "low" | "medium" | "high" | "xhigh" | "max"
}

export interface ProjectCoordinatorPreferences {
  /** Soft limit the coordinator is asked to respect; not a hard cap. */
  maxConcurrentThreads?: number
  /** Coordinator proposes threads and waits for the user to start them. */
  proposeBeforeStart?: boolean
  /** Hard cap on threads created per local day; enforced at admission. */
  dailyThreadCap?: number
  /** Deliver PR nudges (CI failed, review comments, conflicts) into the thread. */
  autoFixPr?: boolean
}

export interface ProjectCoordinatorConfig {
  enabled: boolean
  /** The coordinator conversation, once created. */
  sessionId?: string
  /** One line the coordinator works toward. PII-gated on save and on injection. */
  goal?: string
  threadExecution?: ProjectThreadExecution
  preferences?: ProjectCoordinatorPreferences
  /** Present while paused: no turn in this workspace starts until resumed. */
  paused?: { at: number; reason?: string }
  model?: {
    coordinator?: ProjectCoordinatorModelChoice
    threads?: ProjectCoordinatorModelChoice
  }
  /** Shown beside the workspace name; an emoji. */
  icon?: string
  /** Set once the one-off setup recommendations have been offered. */
  setupOfferedAt?: number
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
