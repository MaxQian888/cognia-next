/**
 * Plugin System Type Definitions
 *
 * Comprehensive type system for Cognia's plugin architecture supporting:
 * - Frontend (TypeScript/React) plugins
 * - Python plugins (via PyO3)
 * - Hybrid plugins combining both
 */

import type {
  A2UIComponent,
  A2UIComponentType as _A2UIComponentType,
  A2UISurfaceType,
} from "../artifact/a2ui"
import type { AgentModeConfig } from "../agent/agent-mode"
import type { Skill as _Skill } from "./_compat"
import type { PluginSchedulerAPI } from "./plugin-scheduler"
import type { PluginVerificationSnapshot } from "./plugin-verification"
// `ActivationEventDeclaration` lives in `lib/plugin/contracts/plugin-points`,
// added by Task #10. Importing the real type keeps the manifest schema and
// the runtime parser in lockstep — historically a local alias was used to
// avoid a dep cycle, but the contracts module has no upward imports so the
// real type is safe to bring in here.
import type { ActivationEventDeclaration } from "@/lib/plugin/contracts/plugin-points"

// =============================================================================
// Core Plugin Types
// =============================================================================

/**
 * Plugin type - determines the runtime environment
 */
export type PluginType =
  | "frontend" // JavaScript/TypeScript plugin running in renderer
  | "python" // Python plugin running via PyO3
  | "hybrid" // Combination of frontend and Python components

/**
 * Plugin capabilities - what the plugin can provide
 */
export type PluginCapability =
  | "tools" // Provides Agent tools
  | "components" // Provides A2UI components
  | "modes" // Provides Agent modes
  | "skills" // Provides Skills
  | "media" // Provides media processing and AI image workflows
  | "canvas" // Provides canvas editing and selection workflows
  | "ai-provider" // Provides AI provider fallback and routing helpers
  | "themes" // Provides UI themes
  | "commands" // Provides slash commands
  | "hooks" // Provides lifecycle hooks
  | "processors" // Provides message processors
  | "providers" // Provides AI model providers
  | "exporters" // Provides export formats
  | "importers" // Provides import handlers
  | "a2ui" // A2UI integration
  | "python" // Python runtime capability
  | "scheduler" // Provides scheduled tasks
  | "external-agent-preset" // cognia-next: contributes external-agent presets (Claude Code / Codex / etc.)
  | "connectors" // Provides Platform Connector adapters (Task 110)
  | "workflow" // Contributes custom workflow node executors (ADR 0017)
  | "workflow-trigger" // Contributes custom workflow trigger sources (ADR 0017)

/**
 * Plugin status in the lifecycle
 */
export type PluginStatus =
  | "discovered" // Found but not loaded
  | "installed" // Downloaded/copied to plugins directory
  | "loading" // Currently loading
  | "loaded" // Loaded but not enabled
  | "enabling" // Currently enabling
  | "enabled" // Active and running
  | "disabling" // Currently disabling
  | "disabled" // Loaded but inactive
  | "unloading" // Currently unloading
  | "error" // Error state
  | "updating" // Being updated

/**
 * Plugin source - where the plugin came from
 */
export type PluginSource =
  | "builtin" // Bundled with the app
  | "local" // Installed from local directory
  | "marketplace" // Downloaded from marketplace
  | "git" // Cloned from git repository
  | "dev" // Development mode (hot reload enabled)

export type PluginRuntimeProfile = "browser" | "tauri"

export type PluginRuntimeAvailability = "supported" | "degraded" | "blocked"

export interface PluginRuntimeCompatibilityTarget {
  availability: PluginRuntimeAvailability
  reason?: string
  entrypoint?: string
}

export interface PluginRuntimeCompatibilityMap {
  browser?: PluginRuntimeCompatibilityTarget
  tauri?: PluginRuntimeCompatibilityTarget
}

export interface PluginReview {
  rating: number
  content: string
  author: string
  createdAt: string
}

/**
 * Normalized installation root kind used by the host.
 */
export type PluginInstallRootKind = "builtin" | "installed" | "dev"

/**
 * Actions supported by a normalized extension record.
 */
export type ExtensionOperation =
  | "install"
  | "update"
  | "enable"
  | "disable"
  | "reload"
  | "rollback"
  | "uninstall"
  | "configure"

export interface ExtensionCompatibilityDiagnostic {
  code: string
  severity: "warning" | "error"
  message: string
  field?: string
  expected?: string
  actual?: string
  hint?: string
}

export interface ExtensionCompatibilitySummary {
  status: "compatible" | "warning" | "blocked"
  diagnostics: ExtensionCompatibilityDiagnostic[]
}

export interface ExtensionInstallRoot {
  kind: PluginInstallRootKind
  path: string
}

export interface ExtensionCanonicalIdentity {
  canonicalId: string
  observedSources: PluginSource[]
  activeSource: PluginSource
}

export type PluginResolvedIcon =
  | {
      kind: "lucide"
      name: string
      original: string
    }
  | {
      kind: "image"
      src: string
      original: string
      transport: "remote" | "inline" | "file" | "public"
    }
  | {
      kind: "fallback"
      reason: "missing" | "outside-plugin-root" | "unsupported" | "invalid"
      original?: string
    }

/**
 * Canonical host-side extension descriptor.
 */
export interface ExtensionDescriptor {
  id: string
  version: string
  source: PluginSource
  identity: ExtensionCanonicalIdentity
  resolvedPath: string
  installRoot: ExtensionInstallRoot
  entrypoints: {
    main?: string
    pythonMain?: string
    styles?: string
  }
  declaredCapabilities: PluginCapability[]
  compatibility: ExtensionCompatibilitySummary
  availableOperations: ExtensionOperation[]
}

export interface ExtensionCatalogEntry {
  id: string
  name: string
  description: string
  author: string
  capabilities: PluginCapability[]
  version: string
  latestVersion: string
  updatedAt: string
  installed: boolean
  enabled: boolean
  source: PluginSource | "marketplace"
  descriptor?: ExtensionDescriptor
  verificationSnapshot?: PluginVerificationSnapshot
  lastKnownGoodVerification?: PluginVerificationSnapshot
  repository?: string
  homepage?: string
  license?: string
  icon?: string
  resolvedIcon?: PluginResolvedIcon
  compatibility: ExtensionCompatibilitySummary
  availableOperations: ExtensionOperation[]
  registry: {
    verified: boolean
    featured: boolean
    downloads: number
    rating: number
    ratingCount: number
    tags: string[]
    categories: string[]
  }
}

/**
 * Permission types that plugins can request
 */
export type PluginPermission =
  | "filesystem:read" // Read files
  | "filesystem:write" // Write files
  | "network:fetch" // Make HTTP requests
  | "network:websocket" // WebSocket connections
  | "clipboard:read" // Read clipboard
  | "clipboard:write" // Write clipboard
  | "notification" // Show notifications
  | "shell:execute" // Execute shell commands
  | "process:spawn" // Spawn processes
  | "database:read" // Read from database
  | "database:write" // Write to database
  | "settings:read" // Read settings
  | "settings:write" // Modify settings
  | "session:read" // Read chat sessions
  | "session:write" // Modify chat sessions
  | "media:image:read" // Read image media assets
  | "media:image:write" // Write image media assets
  | "media:video:read" // Read video media assets
  | "media:video:write" // Write video media assets
  | "media:video:export" // Export rendered video output
  | "agent:control" // Control agent execution
  | "python:execute" // Execute Python code
  | "sandbox:web-execute" // Execute code in browser sandbox (Pyodide/JS)

export type PluginPermissionDecision = "allow" | "deny"
export type PluginPermissionPolicy = "ask" | "allow" | "deny"

// =============================================================================
// Plugin Manifest
// =============================================================================

/**
 * Plugin manifest - describes a plugin's metadata and requirements
 */
export interface PluginManifest {
  /** Unique plugin identifier (reverse domain notation recommended) */
  id: string

  /** Human-readable name */
  name: string

  /** Semantic version (semver) */
  version: string

  /** Plugin description */
  description: string

  /** Author information */
  author?: {
    name: string
    email?: string
    url?: string
  }

  /** Homepage/documentation URL */
  homepage?: string

  /** Repository URL */
  repository?: string

  /** License identifier (SPDX) */
  license?: string

  /** Plugin type */
  type: PluginType

  /** Capabilities this plugin provides */
  capabilities: PluginCapability[]

  /** Keywords for search/discovery */
  keywords?: string[]

  /** Icon (Lucide icon name or data URL) */
  icon?: string

  /** Preview images */
  screenshots?: string[]

  // Entry Points
  /** Main entry point for frontend code */
  main?: string

  /** Entry point for Python code */
  pythonMain?: string

  /** Style entry point (CSS) */
  styles?: string

  // Dependencies
  /** Plugin dependencies */
  dependencies?: Record<string, string>

  /** Host application version requirements */
  engines?: {
    cognia?: string
    node?: string
    python?: string
  }

  /** Minimum host application version required to activate this plugin */
  minAppVersion?: string

  /** Runtime compatibility metadata across supported host profiles */
  runtimeCompatibility?: PluginRuntimeCompatibilityMap

  /** Python package dependencies */
  pythonDependencies?: string[]

  // Configuration
  /** JSON Schema for plugin configuration */
  configSchema?: PluginConfigSchema

  /** Default configuration values */
  defaultConfig?: Record<string, unknown>

  // Permissions
  /** Required permissions */
  permissions?: PluginPermission[]

  /** Optional permissions (requested at runtime) */
  optionalPermissions?: PluginPermission[]

  // A2UI Integration
  /** Custom A2UI components provided */
  a2uiComponents?: A2UIPluginComponentDef[]

  /** A2UI surface templates provided */
  a2uiTemplates?: A2UITemplateDef[]

  // Agent Integration
  /** Agent tools provided */
  tools?: PluginToolDef[]

  /** Agent modes provided */
  modes?: PluginModeDef[]

  /** Slash commands provided */
  commands?: PluginManifestCommandDef[]

  // Activation
  /** Activation events - when to load the plugin */
  activationEvents?: PluginActivationEvent[]

  /** Whether plugin should be loaded at startup */
  activateOnStartup?: boolean

  // Scheduled Tasks
  /** Scheduled tasks provided by this plugin */
  scheduledTasks?: PluginScheduledTaskDef[]

  // Platform Connectors (Task 110)
  /**
   * Platform Connector adapters provided by this plugin.
   * Each entry describes a factory function the connectors bridge will call to
   * instantiate a `PlatformAdapter`.
   */
  connectors?: PluginConnectorDef[]

  // Visual Workflows (ADR 0017)
  /**
   * Custom workflow node executors and trigger sources contributed by this
   * plugin. The host's `lib/plugin/workflow-bridge.ts` reads this block on
   * plugin enable, calls each `execute` / `start` factory the plugin's main
   * entry exposes, and registers them with the workflow runtime — they then
   * appear in the editor's Sidebar palette and are schedulable like
   * built-ins. The `workflow` and `workflow-trigger` capability flags must
   * be declared in `capabilities[]` for the bridge to pick them up.
   */
  workflows?: import("./plugin-workflow").PluginManifestWorkflowsBlock

  // Themes (capability "themes")
  /**
   * UI theme contributions surfaced in Settings → Appearance → Theme as
   * VSCode-style preset cards. Two declaration shapes:
   *   - inline `{ id, name, colors, isDark? }` — direct ThemeColors object.
   *   - `{ id, name, vscodeJsonPath }` — path (relative to the plugin root)
   *     to a VSCode color theme `.json` file; parsed through the same
   *     pipeline the import dialog uses.
   * Both shapes register an in-memory `PluginTheme`; the `themes-bridge`
   * resolves them on plugin enable and unregisters them on disable.
   */
  themes?: PluginThemeContribution[]
}

/**
 * One theme entry inside `PluginManifest.themes`. Plugins may either inline
 * a full ThemeColors object or point at a VSCode `.json` file shipped with
 * the plugin. The bridge uses path-traversal guards on `vscodeJsonPath`.
 *
 * Note: `ThemeColors` lives in `types/plugin/plugin-extended.ts`; we use a
 * structural alias here to avoid importing across the plugin/type boundary
 * (which would otherwise pull `Skill` and the agent-mode chain into this
 * module). The bridge enforces the full shape at runtime.
 */
export type PluginManifestThemeColors = Record<string, string>

export type PluginThemeContribution =
  | {
      id: string
      name: string
      isDark?: boolean
      colors: PluginManifestThemeColors
    }
  | {
      id: string
      name: string
      vscodeJsonPath: string
    }

/**
 * One connector adapter definition inside `PluginManifest.connectors`.
 */
export interface PluginConnectorDef {
  /** Platform kind string (e.g. "telegram", "discord", or a custom string for 3rd-party platforms). */
  type: string
  /**
   * Name of the exported factory function from the plugin's `main` entrypoint.
   * Signature: `(ctx: AdapterContext) => PlatformAdapter | Promise<PlatformAdapter>`
   */
  factory: string
  /** JSON Schema (draft-07) describing the per-instance settings shape. */
  configSchema: object
  /** Default trigger policy (optional — overridden by the bus defaults if absent). */
  defaultTrigger?: Record<string, unknown>
  /** Transport modes this adapter supports. */
  transportModes: string[]
}

/**
 * Scheduled task definition in plugin manifest
 */
export interface PluginScheduledTaskDef {
  /** Task name */
  name: string

  /** Task description */
  description?: string

  /** Handler function name */
  handler: string

  /** Trigger configuration */
  trigger: PluginManifestTaskTrigger

  /** Whether task is enabled by default */
  defaultEnabled?: boolean

  /** Retry configuration */
  retry?: {
    maxAttempts: number
    delaySeconds: number
  }

  /** Timeout in seconds */
  timeout?: number

  /** Tags for organization */
  tags?: string[]
}

/**
 * Task trigger configuration in manifest
 */
export type PluginManifestTaskTrigger =
  | { type: "cron"; expression: string; timezone?: string }
  | { type: "interval"; seconds: number }
  | { type: "once"; runAt: string }
  | { type: "event"; eventType: string; eventSource?: string }

/**
 * Configuration schema definition
 */
export interface PluginConfigSchema {
  type: "object"
  properties: Record<string, PluginConfigProperty>
  required?: string[]
}

export interface PluginConfigProperty {
  type: "string" | "number" | "boolean" | "array" | "object"
  title?: string
  description?: string
  default?: unknown
  enum?: unknown[]
  enumDescriptions?: string[]
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  pattern?: string
  items?: PluginConfigProperty
  properties?: Record<string, PluginConfigProperty>
}

/**
 * Activation events
 */
export type PluginActivationEvent = ActivationEventDeclaration

// =============================================================================
// A2UI Integration Types
// =============================================================================

/**
 * A2UI component definition in plugin manifest
 */
export interface A2UIPluginComponentDef {
  /** Component type name */
  type: string

  /** Display name */
  name: string

  /** Description */
  description?: string

  /** Category for organization */
  category?: "layout" | "form" | "display" | "data" | "custom"

  /** Icon (Lucide name) */
  icon?: string

  /** JSON Schema for component props */
  propsSchema?: Record<string, unknown>

  /** Whether component supports children */
  supportsChildren?: boolean

  /** Default props */
  defaultProps?: Record<string, unknown>
}

/**
 * A2UI template definition
 */
export interface A2UITemplateDef {
  /** Template ID */
  id: string

  /** Display name */
  name: string

  /** Description */
  description?: string

  /** Template category */
  category?: string

  /** Icon */
  icon?: string

  /** Surface type */
  surfaceType: A2UISurfaceType

  /** Preview image */
  preview?: string

  /** Component tree */
  components: A2UIComponent[]

  /** Initial data model */
  dataModel?: Record<string, unknown>

  /** Tags for search */
  tags?: string[]
}

/**
 * Registered A2UI component from plugin
 */
export interface PluginA2UIComponent {
  /** Component type (used in A2UI spec) */
  type: string

  /** Plugin that provides this component */
  pluginId: string

  /** React component */
  component: React.ComponentType<A2UIPluginComponentProps>

  /** Component metadata */
  metadata: A2UIPluginComponentDef
}

/**
 * Props passed to plugin A2UI components
 */
export interface A2UIPluginComponentProps {
  /** Component definition */
  component: A2UIComponent

  /** Surface ID */
  surfaceId: string

  /** Data model */
  dataModel: Record<string, unknown>

  /** Action handler */
  onAction: (action: string, data?: Record<string, unknown>) => void

  /** Data change handler */
  onDataChange: (path: string, value: unknown) => void

  /** Child renderer */
  renderChild: (componentId: string) => React.ReactNode

  /** Plugin context */
  pluginContext: PluginContext
}

// =============================================================================
// Tool Integration Types
// =============================================================================

/**
 * Tool definition in plugin manifest
 */
export interface PluginToolDef {
  /** Tool name */
  name: string

  /** Description for AI */
  description: string

  /** Category */
  category?: string

  /** Whether tool requires user approval */
  requiresApproval?: boolean

  /** JSON Schema for parameters */
  parametersSchema: Record<string, unknown>
}

/**
 * Registered tool from plugin
 */
export interface PluginTool {
  /** Tool name */
  name: string

  /** Plugin that provides this tool */
  pluginId: string

  /** Tool definition */
  definition: PluginToolDef

  /** Execute function */
  execute: (args: Record<string, unknown>, context: PluginToolContext) => Promise<unknown>
}

/**
 * Context passed to tool execution
 */
export interface PluginToolContext {
  /** Current session ID */
  sessionId?: string

  /** Current message ID */
  messageId?: string

  /** Plugin configuration */
  config: Record<string, unknown>

  /** Report progress */
  reportProgress?: (progress: number, message?: string) => void

  /** Abort signal */
  signal?: AbortSignal
}

// =============================================================================
// Mode Integration Types
// =============================================================================

/**
 * Mode definition in plugin manifest
 */
export interface PluginModeDef {
  /** Mode ID */
  id: string

  /** Display name */
  name: string

  /** Description */
  description: string

  /** Icon (Lucide name) */
  icon: string

  /** System prompt */
  systemPrompt?: string

  /** Available tools */
  tools?: string[]

  /** Output format */
  outputFormat?: "text" | "code" | "html" | "react" | "markdown"

  /** Whether preview is enabled */
  previewEnabled?: boolean
}

/**
 * Command definition in plugin manifest
 */
export interface PluginManifestCommandDef {
  /** Command ID (plugin-local or namespaced) */
  id: string

  /** Display name */
  name: string

  /** Description */
  description?: string

  /** Icon (Lucide name) */
  icon?: string

  /** Optional slash command aliases */
  aliases?: string[]
}

// =============================================================================
// Plugin Hooks
// =============================================================================

/**
 * Hook definitions that plugins can implement
 */
export interface PluginHooks {
  // Lifecycle hooks
  onLoad?: () => Promise<void> | void
  onEnable?: () => Promise<void> | void
  onDisable?: () => Promise<void> | void
  onUnload?: () => Promise<void> | void
  onConfigChange?: (config: Record<string, unknown>) => void

  // A2UI hooks
  onA2UISurfaceCreate?: (surfaceId: string, type: A2UISurfaceType) => void
  onA2UISurfaceDestroy?: (surfaceId: string) => void
  onA2UIAction?: (action: PluginA2UIAction) => void | Promise<void>
  onA2UIDataChange?: (change: PluginA2UIDataChange) => void

  // Agent hooks
  onAgentStart?: (agentId: string, config: Record<string, unknown>) => void
  onAgentStep?: (agentId: string, step: PluginAgentStep) => void
  onAgentToolCall?: (agentId: string, tool: string, args: unknown) => unknown | Promise<unknown>
  onAgentComplete?: (agentId: string, result: unknown) => void
  onAgentError?: (agentId: string, error: Error) => void

  // Message hooks
  onMessageSend?: (message: PluginMessage) => PluginMessage | Promise<PluginMessage>
  onMessageReceive?: (message: PluginMessage) => PluginMessage | Promise<PluginMessage>
  onMessageRender?: (message: PluginMessage) => React.ReactNode | null
  /** Called when a message is deleted */
  onMessageDelete?: (messageId: string, sessionId: string) => void
  /** Called when a message is edited */
  onMessageEdit?: (
    messageId: string,
    oldContent: string,
    newContent: string,
    sessionId: string
  ) => void

  // Session hooks
  onSessionCreate?: (sessionId: string) => void
  onSessionSwitch?: (sessionId: string) => void
  onSessionDelete?: (sessionId: string) => void
  /** Called when a session is renamed */
  onSessionRename?: (sessionId: string, oldTitle: string, newTitle: string) => void
  /** Called when all messages in a session are cleared */
  onSessionClear?: (sessionId: string) => void

  // Command hooks
  onCommand?: (command: string, args: string[]) => boolean | Promise<boolean>

  // Chat flow hooks
  /** Called when user regenerates an AI response */
  onChatRegenerate?: (messageId: string, sessionId: string) => void
  /** Called when the AI model/provider is switched */
  onModelSwitch?: (
    provider: string,
    model: string,
    previousProvider?: string,
    previousModel?: string
  ) => void
  /** Called when chat mode switches (chat/agent/learning) */
  onChatModeSwitch?: (sessionId: string, newMode: string, previousMode: string) => void
  /** Called when the system prompt is changed at runtime */
  onSystemPromptChange?: (sessionId: string, newPrompt: string, previousPrompt?: string) => void

  // Agent plan hooks
  /** Called when an agent creates an execution plan */
  onAgentPlanCreate?: (agentId: string, tasks: { id: string; description: string }[]) => void
  /** Called when an agent plan step completes */
  onAgentPlanStepComplete?: (
    agentId: string,
    taskId: string,
    result: string,
    success: boolean
  ) => void

  // Scheduler hooks
  /** Called when a scheduled task starts execution */
  onScheduledTaskStart?: (taskId: string, executionId: string) => void
  /** Called when a scheduled task completes successfully */
  onScheduledTaskComplete?: (
    taskId: string,
    executionId: string,
    result: { success: boolean; output?: Record<string, unknown>; error?: string }
  ) => void
  /** Called when a scheduled task fails */
  onScheduledTaskError?: (taskId: string, executionId: string, error: Error) => void
}

export interface PluginA2UIAction {
  surfaceId: string
  action: string
  componentId: string
  data?: Record<string, unknown>
}

export interface PluginA2UIDataChange {
  surfaceId: string
  path: string
  value: unknown
  previousValue?: unknown
}

export interface PluginAgentStep {
  stepNumber: number
  type: "thinking" | "tool_call" | "tool_result" | "response"
  content?: string
  tool?: string
  toolArgs?: unknown
  toolResult?: unknown
}

export interface PluginMessage {
  id: string
  role: "user" | "assistant" | "system"
  content: string
  metadata?: Record<string, unknown>
}

// =============================================================================
// Plugin Command Types
// =============================================================================

/**
 * Command definition
 */
export interface PluginCommand {
  /** Command ID (plugin-prefixed) */
  id: string

  /** Display name */
  name: string

  /** Description */
  description?: string

  /** Icon */
  icon?: string

  /** Keyboard shortcut */
  shortcut?: string

  /** Whether command is enabled */
  enabled?: boolean | (() => boolean)

  /** Execute handler */
  execute: (args?: Record<string, unknown>) => void | Promise<void>
}

// =============================================================================
// Plugin Context & API
// =============================================================================

/**
 * Context provided to plugins
 */
export interface PluginContext {
  /** Plugin ID */
  pluginId: string

  /** Plugin directory path */
  pluginPath: string

  /** Plugin configuration */
  config: Record<string, unknown>

  /** Logger */
  logger: PluginLogger

  /** Storage API */
  storage: PluginStorage

  /** Event emitter */
  events: PluginEventEmitter

  /** UI API */
  ui: PluginUIAPI

  /** A2UI API */
  a2ui: PluginA2UIAPI

  /** Agent API */
  agent: PluginAgentAPI

  /** Settings API */
  settings: PluginSettingsAPI

  /** Python API (if hybrid plugin) */
  python?: PluginPythonAPI

  /** Network API for HTTP requests */
  network: PluginNetworkAPI

  /** File System API */
  fs: PluginFileSystemAPI

  /** Clipboard API */
  clipboard: PluginClipboardAPI

  /** Shell API for command execution */
  shell: PluginShellAPI

  /** Database API */
  db: PluginDatabaseAPI

  /** Keyboard Shortcuts API */
  shortcuts: PluginShortcutsAPI

  /** Context Menu API */
  contextMenu: PluginContextMenuAPI

  /** Window API */
  window: PluginWindowAPI

  /** Secrets API for secure storage */
  secrets: PluginSecretsAPI

  /** Scheduler API for scheduled tasks */
  scheduler: PluginSchedulerAPI

  /**
   * Visual workflow extension API. Plugins use this to contribute custom
   * node executors and trigger sources to the workflow runtime. See ADR
   * 0017. Only available when the host has wired
   * `lib/plugin/workflow-bridge.ts` (default in cognia-next 0.3.0+).
   */
  workflow: PluginWorkflowAPI
}

/**
 * Plugin-facing API for contributing workflow nodes and triggers to the
 * editor catalog + runtime. Each `register*` returns an unsubscribe
 * function the host calls during `deactivate`. Internally the host
 * prefixes `kind` with `<pluginId>.` automatically; plugin authors should
 * not include the prefix themselves.
 */
export interface PluginWorkflowAPI {
  /**
   * Contribute a custom node executor. The kind is auto-prefixed with the
   * plugin id, so a plugin with id `acme.fetch` registering kind
   * `"action.fetchPage"` ends up as `"action.acme.fetch.fetchPage"` in
   * the editor.
   */
  registerNode(def: import("./plugin-workflow").PluginNodeDef): () => void

  /** Contribute a trigger source (long-running event emitter). */
  registerTrigger(def: import("./plugin-workflow").PluginTriggerDef): () => void

  /**
   * Convenience for plugins whose triggers want to forward an event
   * synthesized from outside the trigger context (e.g. a webhook the
   * plugin registered with the host's HTTP router). Routes to the
   * orchestrator's standard trigger queue.
   */
  emitTriggerEvent(workflowId: string, kind: string, payload: unknown): void
}

export interface PluginLogger {
  debug: (message: string, ...args: unknown[]) => void
  info: (message: string, ...args: unknown[]) => void
  warn: (message: string, ...args: unknown[]) => void
  error: (message: string, ...args: unknown[]) => void
  trace?: (message: string, ...args: unknown[]) => void
  fatal?: (message: string, ...args: unknown[]) => void
  child?: (scope: string) => PluginLogger
  withContext?: (context: Record<string, unknown>) => PluginLogger
}

export interface PluginStorage {
  get: <T>(key: string) => Promise<T | undefined>
  set: <T>(key: string, value: T) => Promise<void>
  delete: (key: string) => Promise<void>
  keys: () => Promise<string[]>
  clear: () => Promise<void>
  /**
   * Convenience alias for `delete`. Some plugin authors prefer this name;
   * implementations may forward to `delete`.
   */
  remove?: (key: string) => Promise<void>
  /** Returns true when the key has a value. */
  has?: (key: string) => Promise<boolean>
  /**
   * Encrypted-at-rest storage for sensitive values (API tokens, OAuth
   * secrets). Implementations should encrypt with the host keychain or
   * secure-storage backend before persisting.
   */
  setSecure?: <T>(key: string, value: T) => Promise<void>
  /** Decrypts a value previously stored via `setSecure`. */
  getSecure?: <T>(key: string) => Promise<T | undefined>
}

export interface PluginEventEmitter {
  on: (event: string, handler: (...args: unknown[]) => void) => () => void
  off: (event: string, handler: (...args: unknown[]) => void) => void
  emit: (event: string, ...args: unknown[]) => void
  once: (event: string, handler: (...args: unknown[]) => void) => () => void
}

export interface PluginUIAPI {
  showNotification: (options: PluginNotification) => void
  showToast: (message: string, type?: "info" | "success" | "warning" | "error") => void
  showDialog: (options: PluginDialog) => Promise<unknown>
  showInputDialog: (options: PluginInputDialog) => Promise<string | null>
  showConfirmDialog: (options: PluginConfirmDialog) => Promise<boolean>
  registerStatusBarItem: (item: PluginStatusBarItem) => () => void
  registerSidebarPanel: (panel: PluginSidebarPanel) => () => void
}

export interface PluginNotification {
  title: string
  body?: string
  message?: string
  type?: "info" | "success" | "warning" | "error"
  icon?: string
  timeout?: number
  actions?: Array<{ label: string; action: string }>
}

export interface PluginDialog {
  title: string
  content: React.ReactNode
  actions?: Array<{ label: string; value: unknown; variant?: string }>
}

export interface PluginInputDialog {
  title: string
  message?: string
  placeholder?: string
  defaultValue?: string
  validate?: (value: string) => string | null
}

export interface PluginConfirmDialog {
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  variant?: "default" | "destructive"
}

export interface PluginStatusBarItem {
  id: string
  text: string
  icon?: string
  tooltip?: string
  onClick?: () => void
  priority?: number
}

export interface PluginSidebarPanel {
  id: string
  title: string
  icon: string
  component: React.ComponentType
  position?: "top" | "bottom"
}

export interface PluginA2UIAPI {
  createSurface: (id: string, type: A2UISurfaceType, options?: { title?: string }) => void
  deleteSurface: (id: string) => void
  updateComponents: (surfaceId: string, components: A2UIComponent[]) => void
  updateDataModel: (surfaceId: string, data: Record<string, unknown>, merge?: boolean) => void
  getSurface: (id: string) => unknown | undefined
  registerComponent: (component: PluginA2UIComponent) => void
  registerTemplate: (template: A2UITemplateDef) => void
}

export interface PluginAgentAPI {
  registerTool: (tool: PluginTool) => void
  unregisterTool: (name: string) => void
  registerMode: (mode: AgentModeConfig) => void
  unregisterMode: (id: string) => void
  executeAgent: (config: Record<string, unknown>) => Promise<unknown>
  cancelAgent: (agentId: string) => void
}

export interface PluginSettingsAPI {
  get: <T>(key: string) => T | undefined
  set: <T>(key: string, value: T) => void
  onChange: (key: string, handler: (value: unknown) => void) => () => void
}

export interface PluginPythonAPI {
  call: <T>(functionName: string, ...args: unknown[]) => Promise<T>
  eval: <T>(code: string, locals?: Record<string, unknown>) => Promise<T>
  import: (moduleName: string) => Promise<PluginPythonModule>
}

export interface PluginPythonModule {
  call: <T>(functionName: string, ...args: unknown[]) => Promise<T>
  getattr: <T>(name: string) => Promise<T>
}

// =============================================================================
// Extended Plugin APIs
// =============================================================================

/**
 * Network API for making HTTP requests
 */
export interface PluginNetworkAPI {
  /** Make a GET request */
  get: <T>(url: string, options?: NetworkRequestOptions) => Promise<NetworkResponse<T>>
  /** Make a POST request */
  post: <T>(
    url: string,
    body?: unknown,
    options?: NetworkRequestOptions
  ) => Promise<NetworkResponse<T>>
  /** Make a PUT request */
  put: <T>(
    url: string,
    body?: unknown,
    options?: NetworkRequestOptions
  ) => Promise<NetworkResponse<T>>
  /** Make a DELETE request */
  delete: <T>(url: string, options?: NetworkRequestOptions) => Promise<NetworkResponse<T>>
  /** Make a PATCH request */
  patch: <T>(
    url: string,
    body?: unknown,
    options?: NetworkRequestOptions
  ) => Promise<NetworkResponse<T>>
  /** Generic fetch with full control */
  fetch: <T>(url: string, options?: NetworkRequestOptions) => Promise<NetworkResponse<T>>
  /** Download a file */
  download: (url: string, destPath: string, options?: DownloadOptions) => Promise<DownloadResult>
  /** Upload a file */
  upload: (
    url: string,
    filePath: string,
    options?: UploadOptions
  ) => Promise<NetworkResponse<unknown>>
}

export interface NetworkRequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS"
  headers?: Record<string, string>
  body?: unknown
  timeout?: number
  responseType?: "json" | "text" | "blob" | "arraybuffer"
  signal?: AbortSignal
}

export interface NetworkResponse<T> {
  ok: boolean
  status: number
  statusText: string
  headers: Record<string, string>
  data: T
}

export interface DownloadOptions {
  headers?: Record<string, string>
  onProgress?: (progress: DownloadProgress) => void
}

export interface DownloadProgress {
  loaded: number
  total: number
  percent: number
}

export interface DownloadResult {
  path: string
  size: number
  contentType?: string
}

export interface UploadOptions {
  headers?: Record<string, string>
  fieldName?: string
  onProgress?: (progress: DownloadProgress) => void
}

/**
 * File System API for file operations
 */
export interface PluginFileSystemAPI {
  /** Read file as text */
  readText: (path: string) => Promise<string>
  /** Read file as binary */
  readBinary: (path: string) => Promise<Uint8Array>
  /** Read file as JSON */
  readJson: <T>(path: string) => Promise<T>
  /** Write text to file */
  writeText: (path: string, content: string) => Promise<void>
  /** Write binary to file */
  writeBinary: (path: string, content: Uint8Array) => Promise<void>
  /** Write JSON to file */
  writeJson: (path: string, data: unknown, pretty?: boolean) => Promise<void>
  /** Append text to file */
  appendText: (path: string, content: string) => Promise<void>
  /** Check if path exists */
  exists: (path: string) => Promise<boolean>
  /** Create directory */
  mkdir: (path: string, recursive?: boolean) => Promise<void>
  /** Remove file or directory */
  remove: (path: string, recursive?: boolean) => Promise<void>
  /** Copy file or directory */
  copy: (src: string, dest: string) => Promise<void>
  /** Move/rename file or directory */
  move: (src: string, dest: string) => Promise<void>
  /** List directory contents */
  readDir: (path: string) => Promise<FileEntry[]>
  /** Get file/directory info */
  stat: (path: string) => Promise<FileStat>
  /** Watch for file changes */
  watch: (path: string, callback: (event: FileWatchEvent) => void) => () => void
  /** Get plugin data directory */
  getDataDir: () => string
  /** Get plugin cache directory */
  getCacheDir: () => string
  /** Get temp directory */
  getTempDir: () => string
}

export interface FileEntry {
  name: string
  path: string
  isFile: boolean
  isDirectory: boolean
  size?: number
}

export interface FileStat {
  size: number
  isFile: boolean
  isDirectory: boolean
  isSymlink: boolean
  created?: Date
  modified?: Date
  accessed?: Date
  mode?: number
}

export interface FileWatchEvent {
  type: "create" | "modify" | "delete" | "rename"
  path: string
  newPath?: string
}

/**
 * Clipboard API for clipboard access
 */
export interface PluginClipboardAPI {
  /** Read text from clipboard */
  readText: () => Promise<string>
  /** Write text to clipboard */
  writeText: (text: string) => Promise<void>
  /** Read image from clipboard */
  readImage: () => Promise<Uint8Array | null>
  /** Write image to clipboard */
  writeImage: (data: Uint8Array, format?: "png" | "jpeg") => Promise<void>
  /** Check if clipboard has text */
  hasText: () => Promise<boolean>
  /** Check if clipboard has image */
  hasImage: () => Promise<boolean>
  /** Clear clipboard */
  clear: () => Promise<void>
}

/**
 * Shell API for running shell commands
 */
export interface PluginShellAPI {
  /** Execute a shell command */
  execute: (command: string, options?: ShellOptions) => Promise<ShellResult>
  /** Spawn a child process */
  spawn: (command: string, args?: string[], options?: SpawnOptions) => ChildProcess
  /** Open a file or URL with default application */
  open: (path: string) => Promise<void>
  /** Open a path in file explorer */
  showInFolder: (path: string) => Promise<void>
}

export interface ShellOptions {
  cwd?: string
  env?: Record<string, string>
  timeout?: number
  encoding?: string
}

export interface ShellResult {
  code: number
  stdout: string
  stderr: string
  success: boolean
}

export interface SpawnOptions extends ShellOptions {
  detached?: boolean
  windowsHide?: boolean
}

export interface ChildProcess {
  pid: number
  stdin: WritableStream<string>
  stdout: ReadableStream<string>
  stderr: ReadableStream<string>
  kill: (signal?: string) => void
  onExit: (callback: (code: number) => void) => void
}

/**
 * Database API for local database operations
 */
export interface PluginDatabaseAPI {
  /** Execute a query */
  query: <T>(sql: string, params?: unknown[]) => Promise<T[]>
  /** Execute a statement (insert, update, delete) */
  execute: (sql: string, params?: unknown[]) => Promise<DatabaseResult>
  /** Execute multiple statements in a transaction */
  transaction: <T>(fn: (tx: DatabaseTransaction) => Promise<T>) => Promise<T>
  /** Create a table */
  createTable: (name: string, schema: TableSchema) => Promise<void>
  /** Drop a table */
  dropTable: (name: string) => Promise<void>
  /** Check if table exists */
  tableExists: (name: string) => Promise<boolean>
}

export interface DatabaseResult {
  rowsAffected: number
  lastInsertId?: number
}

export interface DatabaseTransaction {
  query: <T>(sql: string, params?: unknown[]) => Promise<T[]>
  execute: (sql: string, params?: unknown[]) => Promise<DatabaseResult>
}

export interface TableSchema {
  columns: TableColumn[]
  primaryKey?: string | string[]
  indexes?: TableIndex[]
}

export interface TableColumn {
  name: string
  type: "text" | "integer" | "real" | "blob" | "boolean" | "datetime"
  nullable?: boolean
  default?: unknown
  unique?: boolean
}

export interface TableIndex {
  name: string
  columns: string[]
  unique?: boolean
}

/**
 * Keyboard Shortcuts API
 */
export interface PluginShortcutsAPI {
  /** Register a global keyboard shortcut */
  register: (shortcut: string, callback: () => void, options?: ShortcutOptions) => () => void
  /** Register multiple shortcuts */
  registerMany: (shortcuts: ShortcutRegistration[]) => () => void
  /** Check if a shortcut is available */
  isAvailable: (shortcut: string) => boolean
  /** Get all registered shortcuts for this plugin */
  getRegistered: () => string[]
}

export interface ShortcutOptions {
  when?: string
  preventDefault?: boolean
  description?: string
}

export interface ShortcutRegistration {
  shortcut: string
  callback: () => void
  options?: ShortcutOptions
}

/**
 * Context Menu API
 */
export interface PluginContextMenuAPI {
  /** Register a context menu item */
  register: (item: ContextMenuItem) => () => void
  /** Register multiple context menu items */
  registerMany: (items: ContextMenuItem[]) => () => void
}

export interface ContextMenuItem {
  id: string
  label: string
  icon?: string
  when?: ContextMenuContext | ContextMenuContext[]
  onClick: (context: ContextMenuClickContext) => void
  submenu?: ContextMenuItem[]
  separator?: boolean
  disabled?: boolean | ((context: ContextMenuClickContext) => boolean)
}

export type ContextMenuContext =
  | "chat:message"
  | "chat:input"
  | "artifact"
  | "sidebar:project"
  | "sidebar:session"
  | "editor"
  | "canvas"

export interface ContextMenuClickContext {
  target: ContextMenuContext
  selection?: string
  messageId?: string
  artifactId?: string
  projectId?: string
  sessionId?: string
  position?: { x: number; y: number }
}

/**
 * Window API for window management
 */
export interface PluginWindowAPI {
  /** Create a new window */
  create: (options: WindowOptions) => Promise<PluginWindow>
  /** Get the main window */
  getMain: () => PluginWindow
  /** Get all windows */
  getAll: () => PluginWindow[]
  /** Focus a window */
  focus: (windowId: string) => void
}

export interface WindowOptions {
  title: string
  width?: number
  height?: number
  minWidth?: number
  minHeight?: number
  maxWidth?: number
  maxHeight?: number
  x?: number
  y?: number
  center?: boolean
  resizable?: boolean
  fullscreen?: boolean
  alwaysOnTop?: boolean
  decorations?: boolean
  transparent?: boolean
  url?: string
  component?: React.ComponentType
}

export interface PluginWindow {
  id: string
  title: string
  setTitle: (title: string) => void
  close: () => void
  minimize: () => void
  maximize: () => void
  unmaximize: () => void
  isMaximized: () => boolean
  setSize: (width: number, height: number) => void
  getSize: () => { width: number; height: number }
  setPosition: (x: number, y: number) => void
  getPosition: () => { x: number; y: number }
  center: () => void
  setAlwaysOnTop: (flag: boolean) => void
  show: () => void
  hide: () => void
  onClose: (callback: () => void) => () => void
}

/**
 * Secrets API for secure storage
 */
export interface PluginSecretsAPI {
  /** Store a secret */
  store: (key: string, value: string) => Promise<void>
  /** Retrieve a secret */
  get: (key: string) => Promise<string | null>
  /** Delete a secret */
  delete: (key: string) => Promise<void>
  /** Check if a secret exists */
  has: (key: string) => Promise<boolean>
}

// =============================================================================
// Plugin Instance
// =============================================================================

/**
 * Plugin instance - runtime representation of a loaded plugin
 */
export interface Plugin {
  /** Plugin manifest */
  manifest: PluginManifest

  /** Current status */
  status: PluginStatus

  /** Plugin source */
  source: PluginSource

  /** Installation path */
  path: string

  /** Normalized runtime descriptor */
  descriptor?: ExtensionDescriptor

  /** Canonical icon metadata for rendering plugin identity */
  resolvedIcon?: PluginResolvedIcon

  /** Current configuration */
  config: Record<string, unknown>

  /** Error message if status is 'error' */
  error?: string

  /** Latest verified runtime snapshot */
  verificationSnapshot?: PluginVerificationSnapshot

  /** Last runtime snapshot known to be good */
  lastKnownGoodVerification?: PluginVerificationSnapshot

  /** Hooks implementation */
  hooks?: PluginHooks

  /** Registered tools */
  tools?: PluginTool[]

  /** Registered components */
  components?: PluginA2UIComponent[]

  /** Registered modes */
  modes?: AgentModeConfig[]

  /** Registered commands */
  commands?: PluginCommand[]

  /** Installation timestamp */
  installedAt?: Date

  /** Last enabled timestamp */
  enabledAt?: Date

  /** Last update timestamp */
  updatedAt?: Date

  /** Last used/accessed timestamp (for sorting by recent) */
  lastUsedAt?: number
}

// =============================================================================
// Plugin Store State
// =============================================================================

/**
 * Plugin store state shape
 */
export interface PluginStoreState {
  /** All registered plugins */
  plugins: Record<string, Plugin>

  /** Plugin load order */
  loadOrder: string[]

  /** Currently loading plugins */
  loading: Set<string>

  /** Plugin errors */
  errors: Record<string, string>

  /** Whether plugin system is initialized */
  initialized: boolean

  /** Plugin directory path */
  pluginDirectory: string

  /** Plugin management settings */
  pluginSettings: {
    autoScanEnabled: boolean
    conflictDetectionEnabled: boolean
    notificationsEnabled: boolean
    developerModeEnabled: boolean
  }

  /** Persisted per-plugin permission decisions */
  rememberedPermissions: Record<string, Partial<Record<PluginPermission, PluginPermissionDecision>>>

  /** Global default permission policy */
  globalPermissionPolicy: PluginPermissionPolicy

  /** Group-level permission policy overrides */
  groupPermissionPolicies: Partial<
    Record<"filesystem" | "network" | "system" | "sensitive", PluginPermissionPolicy>
  >

  /** Persisted plugin reviews keyed by plugin or marketplace id */
  reviews: Record<string, PluginReview[]>
}

// =============================================================================
// Plugin Events
// =============================================================================

/**
 * Events emitted by the plugin system
 */
export type PluginSystemEvent =
  | { type: "plugin:discovered"; pluginId: string; manifest: PluginManifest }
  | { type: "plugin:installed"; pluginId: string }
  | { type: "plugin:loaded"; pluginId: string }
  | { type: "plugin:enabled"; pluginId: string }
  | { type: "plugin:disabled"; pluginId: string }
  | { type: "plugin:unloaded"; pluginId: string }
  | { type: "plugin:uninstalled"; pluginId: string }
  | { type: "plugin:error"; pluginId: string; error: string }
  | { type: "plugin:config-changed"; pluginId: string; config: Record<string, unknown> }

// =============================================================================
// Plugin Definition Helper
// =============================================================================

/**
 * Helper type for defining plugins
 */
export interface PluginDefinition {
  manifest: PluginManifest
  activate: (context: PluginContext) => Promise<PluginHooks | void> | PluginHooks | void
  /**
   * Optional teardown invoked when the plugin is disabled or unloaded.
   * The runtime passes the same `PluginContext` used in `activate` so
   * cleanup can release context-bound resources (subscriptions, secure
   * storage handles, registered commands).
   */
  deactivate?: (context?: PluginContext) => Promise<void> | void
  /** Parsed activation metadata resolved by runtime manager */
  activation?: {
    startup: boolean
    commandEvents: string[]
    toolEvents: string[]
    rawEvents: PluginActivationEvent[]
  }
}

/**
 * Helper function to define a plugin (for type safety)
 */
export function definePlugin(definition: PluginDefinition): PluginDefinition {
  return definition
}

// =============================================================================
// Python Plugin Types
// =============================================================================

/**
 * Python plugin definition (used in Python SDK)
 */
export interface PythonPluginManifest extends Omit<PluginManifest, "main"> {
  type: "python" | "hybrid"
  pythonMain: string
  pythonDependencies?: string[]
}

/**
 * Python tool definition
 */
export interface PythonToolDef {
  name: string
  description: string
  parameters: Record<string, PythonParamDef>
  returns?: PythonParamDef
  requiresApproval?: boolean
}

export interface PythonParamDef {
  type: "string" | "number" | "boolean" | "array" | "object" | "any"
  description?: string
  required?: boolean
  default?: unknown
  enum?: unknown[]
}

/**
 * Python hook registration
 */
export interface PythonHookRegistration {
  hookName: keyof PluginHooks
  functionName: string
  async?: boolean
}

/**
 * IPC message types for Python communication
 */
export type PythonIPCMessage =
  | { type: "call"; id: string; function: string; args: unknown[] }
  | { type: "result"; id: string; result: unknown }
  | { type: "error"; id: string; error: string }
  | { type: "event"; event: string; data: unknown }
  | { type: "log"; level: string; message: string }
  | { type: "register_tool"; tool: PythonToolDef }
  | { type: "register_hook"; hook: PythonHookRegistration }
  | { type: "ready" }
  | { type: "shutdown" }
