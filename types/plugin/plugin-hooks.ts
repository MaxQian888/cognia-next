/**
 * Plugin Hooks Types
 *
 * Additional hook definitions for deeper integration with the application.
 */

import type { PluginHooks, PluginMessage } from "./plugin"
import type { Project, KnowledgeFile, ChatMode } from "./_compat"
import type { Artifact } from "../artifact/artifact"
import type { PluginCanvasDocument } from "./plugin-extended"

// =============================================================================
// Project Hooks
// =============================================================================

/**
 * Project-related hook events
 */
export interface ProjectHookEvents {
  /** Called when a project is created */
  onProjectCreate?: (project: Project) => void | Promise<void>

  /** Called when a project is updated */
  onProjectUpdate?: (project: Project, changes: Partial<Project>) => void | Promise<void>

  /** Called when a project is deleted */
  onProjectDelete?: (projectId: string) => void | Promise<void>

  /** Called when the active project changes */
  onProjectSwitch?: (projectId: string | null, previousProjectId: string | null) => void

  /** Called when a file is added to project knowledge base */
  onKnowledgeFileAdd?: (projectId: string, file: KnowledgeFile) => void | Promise<void>

  /** Called when a knowledge file is removed */
  onKnowledgeFileRemove?: (projectId: string, fileId: string) => void | Promise<void>

  /** Called when a session is linked to a project */
  onSessionLinked?: (projectId: string, sessionId: string) => void

  /** Called when a session is unlinked from a project */
  onSessionUnlinked?: (projectId: string, sessionId: string) => void
}

// =============================================================================
// Canvas Hooks
// =============================================================================

/**
 * Canvas-related hook events
 */
export interface CanvasHookEvents {
  /** Called when a canvas document is created */
  onCanvasCreate?: (document: PluginCanvasDocument) => void | Promise<void>

  /** Called when a canvas document is updated */
  onCanvasUpdate?: (document: PluginCanvasDocument, changes: Partial<PluginCanvasDocument>) => void

  /** Called when a canvas document is deleted */
  onCanvasDelete?: (documentId: string) => void

  /** Called when the active canvas changes */
  onCanvasSwitch?: (documentId: string | null) => void

  /** Called when canvas content changes (debounced) */
  onCanvasContentChange?: (documentId: string, content: string, previousContent: string) => void

  /** Called when a canvas version is saved */
  onCanvasVersionSave?: (documentId: string, versionId: string) => void

  /** Called when a canvas version is restored */
  onCanvasVersionRestore?: (documentId: string, versionId: string) => void

  /** Called when user selects text in canvas */
  onCanvasSelection?: (
    documentId: string,
    selection: { start: number; end: number; text: string }
  ) => void
}

// =============================================================================
// Artifact Hooks
// =============================================================================

/**
 * Artifact-related hook events
 */
export interface ArtifactHookEvents {
  /** Called when an artifact is created */
  onArtifactCreate?: (artifact: Artifact) => void | Promise<void>

  /** Called when an artifact is updated */
  onArtifactUpdate?: (artifact: Artifact, changes: Partial<Artifact>) => void

  /** Called when an artifact is deleted */
  onArtifactDelete?: (artifactId: string) => void

  /** Called when the artifact panel is opened */
  onArtifactOpen?: (artifactId: string) => void

  /** Called when the artifact panel is closed */
  onArtifactClose?: () => void

  /** Called when artifact code is executed (for React/HTML artifacts) */
  onArtifactExecute?: (artifactId: string, result: { success: boolean; error?: string }) => void

  /** Called when an artifact is exported */
  onArtifactExport?: (artifactId: string, format: string) => void
}

// =============================================================================
// Export Hooks
// =============================================================================

/**
 * Export-related hook events
 */
export interface ExportHookEvents {
  /** Called before a session export starts */
  onExportStart?: (sessionId: string, format: string) => void | Promise<void>

  /** Called after a session export completes */
  onExportComplete?: (sessionId: string, format: string, success: boolean) => void

  /** Called to allow modification of export content */
  onExportTransform?: (content: string, format: string) => string | Promise<string>

  /** Called before a project export starts */
  onProjectExportStart?: (projectId: string, format: string) => void | Promise<void>

  /** Called after a project export completes */
  onProjectExportComplete?: (projectId: string, format: string, success: boolean) => void
}

// =============================================================================
// Theme Hooks
// =============================================================================

/**
 * Theme-related hook events
 */
export interface ThemeHookEvents {
  /** Called when theme mode changes (light/dark/system) */
  onThemeModeChange?: (mode: "light" | "dark" | "system", resolvedMode: "light" | "dark") => void

  /** Called when color preset changes */
  onColorPresetChange?: (preset: string) => void

  /** Called when a custom theme is activated */
  onCustomThemeActivate?: (themeId: string) => void
}

// =============================================================================
// AI/Chat Hooks - Enhanced Types
// =============================================================================

// ChatMode is imported from '../core/session' to avoid duplicate export

/** Attachment for prompt submission */
export interface PromptAttachment {
  id: string
  name: string
  type: "image" | "audio" | "video" | "file" | "document"
  url?: string
  size?: number
  mimeType?: string
}

/** Context for user prompt submission */
export interface PromptSubmitContext {
  attachments?: PromptAttachment[]
  mode: ChatMode
  previousMessages: PluginMessage[]
}

/** Result of user prompt submission hook */
export interface PromptSubmitResult {
  /** Action to take: proceed normally, block the message, or modify it */
  action: "proceed" | "block" | "modify"
  /** Modified prompt content (when action is 'modify') */
  modifiedPrompt?: string
  /** Additional context to inject into system prompt */
  additionalContext?: string
  /** Reason for blocking (when action is 'block') */
  blockReason?: string
}

/** Result of pre-tool-use hook */
export interface PreToolUseResult {
  /** Action to take: allow, deny, or modify the tool call */
  action: "allow" | "deny" | "modify"
  /** Modified arguments (when action is 'modify') */
  modifiedArgs?: unknown
  /** Reason for denying (when action is 'deny') */
  denyReason?: string
}

/** Result of post-tool-use hook */
export interface PostToolUseResult {
  /** Modified result to use instead of original */
  modifiedResult?: unknown
  /** Additional messages to inject into conversation */
  additionalMessages?: PluginMessage[]
}

/** Context for pre-compact hook */
export interface PreCompactContext {
  sessionId: string
  messageCount: number
  tokenCount: number
  compressionRatio: number
}

/** Result of pre-compact hook */
export interface PreCompactResult {
  /** Context to inject into compressed summary */
  contextToInject?: string
  /** Skip compaction entirely */
  skipCompaction?: boolean
  /** Custom compression strategy override */
  customStrategy?: "aggressive" | "moderate" | "minimal"
}

/** Response data for post-chat-receive hook */
export interface ChatResponseData {
  content: string
  messageId: string
  sessionId: string
  model: string
  provider: string
}

/** Result of post-chat-receive hook */
export interface PostChatReceiveResult {
  /** Modified content to display */
  modifiedContent?: string
  /** Additional messages to add after the response */
  additionalMessages?: PluginMessage[]
  /** Additional metadata to store */
  metadata?: Record<string, unknown>
}

/**
 * Structural subset of `SendOptions` (lib/claude/types) plugins are allowed
 * to inspect/transform via `onBuildOptions`. Keeping the type structural —
 * not an import of the full host type — keeps plugin authors decoupled from
 * host-internal fields they shouldn't touch (provider keys, runtime
 * snapshots, the workflow editor block, etc.).
 */
export interface BuildOptionsHookInput {
  /** Resolved session id this turn belongs to. */
  sessionId: string
  /** Model identifier (e.g. `claude-opus-4-7`). */
  model: string
  /** Base system prompt (character + brief mode + skills already merged). */
  systemPrompt?: string
  /** Snippet appended to the system prompt this turn (`appendSystemPrompt`). */
  appendSystemPrompt?: string
  /** Max output tokens for this turn. */
  maxTokens?: number
  /** Temperature. */
  temperature?: number
  /** Allow-list of tool names the agent may call. */
  allowedTools?: string[]
}

/**
 * Plugins return the same shape (with any subset of fields replaced). The
 * dispatcher applies a shallow merge per field; returning `undefined` for a
 * field leaves the prior value untouched. Returning `undefined` (no return)
 * is also OK and means "no change."
 */
export type BuildOptionsHookOutput = Partial<BuildOptionsHookInput> | undefined | void

/**
 * AI and chat-related hook events
 */
export interface AIHookEvents {
  /** Called before a chat request is sent */
  onChatRequest?: (
    messages: PluginMessage[],
    model: string
  ) => PluginMessage[] | Promise<PluginMessage[]>

  /** Called when user submits a prompt (before any processing) */
  onUserPromptSubmit?: (
    prompt: string,
    sessionId: string,
    context: PromptSubmitContext
  ) => PromptSubmitResult | Promise<PromptSubmitResult>

  /** Called before a tool is executed */
  onPreToolUse?: (
    toolName: string,
    toolArgs: unknown,
    sessionId: string
  ) => PreToolUseResult | Promise<PreToolUseResult>

  /** Called after a tool execution completes */
  onPostToolUse?: (
    toolName: string,
    toolArgs: unknown,
    toolResult: unknown,
    sessionId: string
  ) => PostToolUseResult | Promise<PostToolUseResult>

  /** Called before context compression */
  onPreCompact?: (context: PreCompactContext) => PreCompactResult | Promise<PreCompactResult>

  /** Called after receiving AI response */
  onPostChatReceive?: (
    response: ChatResponseData
  ) => PostChatReceiveResult | Promise<PostChatReceiveResult>

  /**
   * Called after the host has resolved the per-turn `SendOptions` block
   * (system prompt, allowed tools, max tokens, etc.) and before the agent
   * SDK is invoked. The plugin can return a transformed options dict; the
   * host applies the result via `dispatchBuildOptions` (transform pipeline,
   * mirrors `dispatchExportTransform`). Plugins that need to short-circuit
   * the entire turn should register a `chat.middleware` instead.
   *
   * The structural shape below carries only the fields plugins are allowed
   * to influence; the full host `SendOptions` is kept private.
   */
  onBuildOptions?: (
    options: BuildOptionsHookInput
  ) => BuildOptionsHookOutput | Promise<BuildOptionsHookOutput>

  /** Called when streaming response starts */
  onStreamStart?: (sessionId: string) => void

  /** Called for each streaming chunk */
  onStreamChunk?: (sessionId: string, chunk: string, fullContent: string) => void

  /** Called when streaming response ends */
  onStreamEnd?: (sessionId: string, finalContent: string) => void

  /** Called when a chat error occurs */
  onChatError?: (sessionId: string, error: Error) => void

  /** Called when token usage is reported */
  onTokenUsage?: (
    sessionId: string,
    usage: { prompt: number; completion: number; total: number }
  ) => void
}

// =============================================================================
// RAG/Vector Hooks
// =============================================================================

/**
 * RAG and vector-related hook events
 */
export interface VectorHookEvents {
  /** Called when documents are added to vector store */
  onDocumentsIndexed?: (collection: string, count: number) => void

  /** Called when a vector search is performed */
  onVectorSearch?: (collection: string, query: string, resultCount: number) => void

  /** Called when RAG context is retrieved for a message */
  onRAGContextRetrieved?: (
    sessionId: string,
    sources: { id: string; content: string; score: number }[]
  ) => void
}

// =============================================================================
// Workflow Hooks
// =============================================================================

/**
 * Workflow integration hook events
 */
export interface WorkflowHookEvents {
  /** Called when a workflow starts */
  onWorkflowStart?: (workflowId: string, name: string) => void

  /** Called when a workflow step completes */
  onWorkflowStepComplete?: (workflowId: string, stepIndex: number, result: unknown) => void

  /** Called when a workflow completes */
  onWorkflowComplete?: (workflowId: string, success: boolean, result?: unknown) => void

  /** Called when a workflow errors */
  onWorkflowError?: (workflowId: string, error: Error) => void

  /** Called immediately before a node executor runs (per-node; may interleave
   * under concurrency — correlate by `nodeId`). */
  onWorkflowNodeStart?: (workflowId: string, nodeId: string, nodeType: string) => void

  /** Called after a node executor produces output. */
  onWorkflowNodeComplete?: (
    workflowId: string,
    nodeId: string,
    nodeType: string,
    output: unknown
  ) => void

  /** Called when a single node's executor throws (distinct from the run-level
   * `onWorkflowError`). */
  onWorkflowNodeError?: (workflowId: string, nodeId: string, error: Error) => void

  /** Called when a trigger fires for a workflow (cron / webhook / connector /
   * chat / plugin), before the run is scheduled. */
  onWorkflowTriggerFired?: (workflowId: string, triggerKind: string, payload: unknown) => void
}

// =============================================================================
// UI Hooks
// =============================================================================

/**
 * Integrated-terminal hook events (plan: vscode-vivid-wilkinson).
 *
 * `onTerminalWillSpawn` gives plugins a chance to veto or modify a new
 * terminal session before the Rust spawn runs. Resolution rules in
 * `dispatchTerminalWillSpawn`:
 *
 *   * Each subscriber may return:
 *     - `"allow"` — explicit pass-through.
 *     - `"deny"` — abort the spawn.
 *     - a `PluginTerminalSpawnRequest` — mutate the request (shell, cwd,
 *       env, etc.). Subsequent plugins see the mutated form.
 *     - `void` / `undefined` — defer, equivalent to `"allow"`.
 *   * The dispatcher iterates by priority and short-circuits on the
 *     first `"deny"`. Mutations are chained.
 *   * Timeout / hook-disabled / hook-error → treated as `"allow"` so
 *     a buggy plugin never wedges the dock.
 *
 * `onTerminalLifecycle` is fire-and-forget — used by audit plugins and
 * the activity log. Never blocks the dock.
 */
export interface PluginTerminalSpawnRequest {
  shell: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  rows: number
  cols: number
  projectId?: string
  extensionId?: string
  enableShellIntegration?: boolean
  origin?: "local" | "remote"
}

export type PluginTerminalSpawnDecision = "allow" | "deny" | PluginTerminalSpawnRequest

export interface PluginTerminalLifecycleEvent {
  kind: "spawned" | "exited" | "killed"
  sessionId: string
  projectId?: string | null
  extensionId?: string | null
  exitCode?: number | null
}

export interface TerminalHookEvents {
  onTerminalWillSpawn?: (
    req: PluginTerminalSpawnRequest
  ) => PluginTerminalSpawnDecision | void | Promise<PluginTerminalSpawnDecision | void>

  onTerminalLifecycle?: (event: PluginTerminalLifecycleEvent) => void
}

/**
 * UI interaction hook events
 */
export interface UIHookEvents {
  /** Called when sidebar visibility changes */
  onSidebarToggle?: (visible: boolean) => void

  /** Called when a panel is opened */
  onPanelOpen?: (panelId: string) => void

  /** Called when a panel is closed */
  onPanelClose?: (panelId: string) => void

  /** Called when a keyboard shortcut is triggered */
  onShortcut?: (shortcut: string) => boolean | void

  /** Called when a context menu is about to be shown */
  onContextMenuShow?: (context: { type: string; target?: unknown }) => { items?: unknown[] } | void
}

// =============================================================================
// Plugin Hooks (Complete)
// =============================================================================

/**
 * Complete plugin hooks interface combining base and event hooks
 */
export interface PluginHooksAll extends PluginHooks {
  // Project hooks
  onProjectCreate?: ProjectHookEvents["onProjectCreate"]
  onProjectUpdate?: ProjectHookEvents["onProjectUpdate"]
  onProjectDelete?: ProjectHookEvents["onProjectDelete"]
  onProjectSwitch?: ProjectHookEvents["onProjectSwitch"]
  onKnowledgeFileAdd?: ProjectHookEvents["onKnowledgeFileAdd"]
  onKnowledgeFileRemove?: ProjectHookEvents["onKnowledgeFileRemove"]
  onSessionLinked?: ProjectHookEvents["onSessionLinked"]
  onSessionUnlinked?: ProjectHookEvents["onSessionUnlinked"]

  // Canvas hooks
  onCanvasCreate?: CanvasHookEvents["onCanvasCreate"]
  onCanvasUpdate?: CanvasHookEvents["onCanvasUpdate"]
  onCanvasDelete?: CanvasHookEvents["onCanvasDelete"]
  onCanvasSwitch?: CanvasHookEvents["onCanvasSwitch"]
  onCanvasContentChange?: CanvasHookEvents["onCanvasContentChange"]
  onCanvasVersionSave?: CanvasHookEvents["onCanvasVersionSave"]
  onCanvasVersionRestore?: CanvasHookEvents["onCanvasVersionRestore"]
  onCanvasSelection?: CanvasHookEvents["onCanvasSelection"]

  // Artifact hooks
  onArtifactCreate?: ArtifactHookEvents["onArtifactCreate"]
  onArtifactUpdate?: ArtifactHookEvents["onArtifactUpdate"]
  onArtifactDelete?: ArtifactHookEvents["onArtifactDelete"]
  onArtifactOpen?: ArtifactHookEvents["onArtifactOpen"]
  onArtifactClose?: ArtifactHookEvents["onArtifactClose"]
  onArtifactExecute?: ArtifactHookEvents["onArtifactExecute"]
  onArtifactExport?: ArtifactHookEvents["onArtifactExport"]

  // Export hooks
  onExportStart?: ExportHookEvents["onExportStart"]
  onExportComplete?: ExportHookEvents["onExportComplete"]
  onExportTransform?: ExportHookEvents["onExportTransform"]
  onProjectExportStart?: ExportHookEvents["onProjectExportStart"]
  onProjectExportComplete?: ExportHookEvents["onProjectExportComplete"]

  // Theme hooks
  onThemeModeChange?: ThemeHookEvents["onThemeModeChange"]
  onColorPresetChange?: ThemeHookEvents["onColorPresetChange"]
  onCustomThemeActivate?: ThemeHookEvents["onCustomThemeActivate"]

  // AI hooks - Core
  onChatRequest?: AIHookEvents["onChatRequest"]
  onStreamStart?: AIHookEvents["onStreamStart"]
  onStreamChunk?: AIHookEvents["onStreamChunk"]
  onStreamEnd?: AIHookEvents["onStreamEnd"]
  onChatError?: AIHookEvents["onChatError"]
  onTokenUsage?: AIHookEvents["onTokenUsage"]

  // AI hooks - Enhanced (Pre/Post operations)
  onUserPromptSubmit?: AIHookEvents["onUserPromptSubmit"]
  onPreToolUse?: AIHookEvents["onPreToolUse"]
  onPostToolUse?: AIHookEvents["onPostToolUse"]
  onPreCompact?: AIHookEvents["onPreCompact"]
  onPostChatReceive?: AIHookEvents["onPostChatReceive"]
  onBuildOptions?: AIHookEvents["onBuildOptions"]

  // Vector/RAG hooks
  onDocumentsIndexed?: VectorHookEvents["onDocumentsIndexed"]
  onVectorSearch?: VectorHookEvents["onVectorSearch"]
  onRAGContextRetrieved?: VectorHookEvents["onRAGContextRetrieved"]

  // Workflow hooks
  onWorkflowStart?: WorkflowHookEvents["onWorkflowStart"]
  onWorkflowStepComplete?: WorkflowHookEvents["onWorkflowStepComplete"]
  onWorkflowComplete?: WorkflowHookEvents["onWorkflowComplete"]
  onWorkflowError?: WorkflowHookEvents["onWorkflowError"]
  onWorkflowNodeStart?: WorkflowHookEvents["onWorkflowNodeStart"]
  onWorkflowNodeComplete?: WorkflowHookEvents["onWorkflowNodeComplete"]
  onWorkflowNodeError?: WorkflowHookEvents["onWorkflowNodeError"]
  onWorkflowTriggerFired?: WorkflowHookEvents["onWorkflowTriggerFired"]

  // UI hooks
  onSidebarToggle?: UIHookEvents["onSidebarToggle"]
  onPanelOpen?: UIHookEvents["onPanelOpen"]
  onPanelClose?: UIHookEvents["onPanelClose"]
  onShortcut?: UIHookEvents["onShortcut"]
  onContextMenuShow?: UIHookEvents["onContextMenuShow"]

  // Terminal hooks
  onTerminalWillSpawn?: TerminalHookEvents["onTerminalWillSpawn"]
  onTerminalLifecycle?: TerminalHookEvents["onTerminalLifecycle"]

  // Message lifecycle hooks
  onMessageDelete?: PluginHooks["onMessageDelete"]
  onMessageEdit?: PluginHooks["onMessageEdit"]

  // Session lifecycle hooks
  onSessionRename?: PluginHooks["onSessionRename"]
  onSessionClear?: PluginHooks["onSessionClear"]

  // Chat flow hooks
  onChatRegenerate?: PluginHooks["onChatRegenerate"]
  onModelSwitch?: PluginHooks["onModelSwitch"]
  onChatModeSwitch?: PluginHooks["onChatModeSwitch"]
  onSystemPromptChange?: PluginHooks["onSystemPromptChange"]

  // Agent plan hooks
  onAgentPlanCreate?: PluginHooks["onAgentPlanCreate"]
  onAgentPlanStepComplete?: PluginHooks["onAgentPlanStepComplete"]

  // Scheduler hooks
  onScheduledTaskStart?: PluginHooks["onScheduledTaskStart"]
  onScheduledTaskComplete?: PluginHooks["onScheduledTaskComplete"]
  onScheduledTaskError?: PluginHooks["onScheduledTaskError"]
  /** Called when a scheduled task is created */
  onScheduledTaskCreate?: (task: {
    id: string
    pluginId: string
    name: string
    trigger: unknown
    handler: string
  }) => void
  /** Called when a scheduled task is updated */
  onScheduledTaskUpdate?: (
    task: { id: string; pluginId: string; name: string },
    changes: Record<string, unknown>
  ) => void
  /** Called when a scheduled task is deleted */
  onScheduledTaskDelete?: (taskId: string) => void
  /** Called when a scheduled task is paused */
  onScheduledTaskPause?: (taskId: string) => void
  /** Called when a scheduled task is resumed */
  onScheduledTaskResume?: (taskId: string) => void
  /** Called before a scheduled task runs (return false to cancel) */
  onScheduledTaskBeforeRun?: (taskId: string, executionId: string) => boolean | Promise<boolean>

  // External Agent hooks
  onExternalAgentConnect?: (agentId: string, agentName: string) => void
  onExternalAgentDisconnect?: (agentId: string) => void
  onExternalAgentExecutionStart?: (agentId: string, sessionId: string, prompt: string) => void
  onExternalAgentExecutionComplete?: (
    agentId: string,
    sessionId: string,
    success: boolean,
    response?: string
  ) => void
  onExternalAgentPermissionRequest?: (
    agentId: string,
    sessionId: string,
    toolName: string,
    reason?: string
  ) => void
  onExternalAgentToolCall?: (
    agentId: string,
    sessionId: string,
    toolName: string,
    args: Record<string, unknown>
  ) => void
  onExternalAgentError?: (agentId: string, error: string) => void

  // Code Execution / Sandbox hooks
  onCodeExecutionStart?: (language: string, code: string, sandboxId?: string) => void
  onCodeExecutionComplete?: (language: string, result: unknown, sandboxId?: string) => void
  onCodeExecutionError?: (language: string, error: Error, sandboxId?: string) => void

  // MCP Server hooks
  onMCPServerConnect?: (serverId: string, serverName: string) => void
  onMCPServerDisconnect?: (serverId: string) => void
  onMCPToolCall?: (serverId: string, toolName: string, args: Record<string, unknown>) => void
  onMCPToolResult?: (serverId: string, toolName: string, result: unknown) => void
}

/**
 * Hook priority levels
 */
export type HookPriority = "high" | "normal" | "low"

/**
 * Hook registration options
 */
export interface HookRegistrationOptions {
  /** Priority level for hook execution order */
  priority?: HookPriority

  /** Whether this hook can cancel the event */
  cancellable?: boolean

  /** Timeout in ms for async hooks */
  timeout?: number
}

/**
 * Hook execution result
 */
export interface HookSandboxExecutionResult<T = unknown> {
  /** Whether hook executed successfully */
  success: boolean

  /** Result value if any */
  result?: T

  /** Error if hook failed */
  error?: Error

  /** Plugin ID that produced the result */
  pluginId: string

  /** Execution time in ms */
  executionTime: number

  /** Duration in ms (alternative to executionTime) */
  duration?: number

  /** Whether hook was skipped */
  skipped?: boolean
}

// =============================================================================
// Backward Compatibility Aliases (Deprecated)
// =============================================================================

/**
 * @deprecated Use `PluginHooksAll` instead
 */
export type ExtendedPluginHooks = PluginHooksAll
