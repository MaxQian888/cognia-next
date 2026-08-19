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
import type { CanonicalPluginPermission } from "@/packages/plugin-sdk/src/contracts/generated"
import type { LspServerConfig } from "../lsp/config"
import type { ExternalAgentPresetConfig } from "@/lib/ai/agent/external/presets"
import type { ProtocolAdapterFactory } from "@/lib/ai/agent/external/protocol-adapter"
import type {
  Skill as _Skill,
  Session,
  CreateSessionInput,
  UpdateSessionInput,
  UIMessage,
  Project,
  CreateProjectInput,
  UpdateProjectInput,
  KnowledgeFile,
  ChatMode,
} from "./_compat"
import type { PluginMcpServerPresetDef } from "./plugin-mcp-preset"
import type { PluginNativeAnthropicToolDef } from "./plugin-native-tool"
import type { PluginCharacterPackDef } from "./plugin-character-pack"
import type { PluginSchedulerAPI } from "./plugin-scheduler"
import type { PluginSkillDef } from "./plugin-skill"
import type { PluginIPCAPI, PluginEventAPI } from "./plugin-messaging"
import type {
  PluginAgentRun,
  PluginAgentRunOptions,
  PluginAgentRunResult,
  PluginDispatchSubagentOptions,
  PluginSubagentDispatchResult,
  PluginRunTeamOptions,
  PluginRunTeamResult,
} from "./plugin-agent-sdk"
import type { PluginAgentGuardrailsAPI } from "./plugin-agent-guardrails"
import type { PluginAgentSessionsAPI } from "./plugin-agent-session"
import type { PluginAgentContextAPI, PluginContextProviderDef } from "./plugin-context-provider"
import type { PluginSubagentDef } from "./plugin-subagent"
import type { AgentTeam } from "@/types/agent/agent-team"
import type { PluginVerificationSnapshot } from "./plugin-verification"
import type { PluginOcrProviderDef } from "./plugin-ocr"
import type { PluginWorkspaceBackendDef } from "./plugin-workspace-backend"
import type { PluginMessageRendererDef } from "./plugin-message-renderer"
import type { PluginToolRendererDef } from "./plugin-tool-renderer"
import type { PluginAiProviderDef } from "./plugin-ai-provider"
import type { PluginTerminalCompletionProviderDef } from "./plugin-terminal-completion"
import type { PluginModalMountDef } from "./plugin-modal"
import type { PluginViewContainerDef } from "./plugin-view-container"
import type { PluginViewDef } from "./plugin-view"
import type { PluginWebviewDef } from "./plugin-webview"
import type { PluginAuthProviderDef } from "./plugin-auth"
import type { PluginChatMiddlewareDef } from "./plugin-chat-middleware"
import type { PluginCliToolDef } from "./plugin-cli-tool"
import type { PluginRoutingStrategyDef } from "./plugin-routing-strategy"
import type { PluginDeploymentFilterDef } from "./plugin-deployment-filter"
import type { PluginProtocolAdapterDef } from "./plugin-protocol-adapter"
import type { PluginExternalAgentAdapterDef } from "./plugin-external-agent-adapter"
import type { PluginSessionImporterDef } from "./plugin-session-importer"
import type { PluginContextPanelDef } from "./plugin-context-panel"
import type { PluginExtensionDef } from "./plugin-extension"
import type { PluginIdeManifest } from "./plugin-ide"
import type { PluginIntegrationDef, PluginIntegrationsAPI } from "./plugin-integration"
// Re-exported so the SDK manifest barrel (`@cognia/plugin-sdk/manifest`) can
// source it from this module, the documented source of truth.
export type { PluginExternalAgentAdapterDef } from "./plugin-external-agent-adapter"
export type { PluginSessionImporterDef } from "./plugin-session-importer"
import type { PluginToolRouteDef } from "./plugin-tool-route"
// `ActivationEventDeclaration` lives in `lib/plugin/contracts/plugin-points`,
// added by Task #10. Importing the real type keeps the manifest schema and
// the runtime parser in lockstep — historically a local alias was used to
// avoid a dep cycle, but the contracts module has no upward imports so the
// real type is safe to bring in here.
import type { ActivationEventDeclaration } from "@/lib/plugin/contracts/plugin-points"
import type { PluginSurfaceFormFactor } from "./plugin-surface"
import type { PluginIconName } from "./plugin-icon"
import type { VsCodeExtensionBlock, VsCodeLanguage } from "./plugin-vscode"
import type {
  Artifact,
  ArtifactLanguage,
  ArtifactType,
  CanvasDocumentVersion,
  CanvasSuggestion,
} from "../artifact/artifact"
import type {
  CanvasActionConfig,
  CanvasActionExecutionOptions,
  CanvasActionResult,
  CanvasActionType,
  StreamingCallbacks,
} from "@/lib/ai/generation/canvas-actions"
import type { AddCommentInput, ReplyInput } from "@/lib/db/canvas-comments"
import type { AgentSessionSourceAdapter } from "@/lib/session-import/types"
import type { ChatImporter } from "@/lib/data/importers/types"
import type { PythonExecResult } from "@/lib/tauri/canvas"
import type { CanvasComment, CollaborativeSession } from "../canvas/collaboration"
// PluginMediaAPI and CanonicalExtensionPoint live in `lib/plugin/api/media-api`
// and `lib/plugin/contracts/plugin-points` respectively. We mark
// `PluginMediaAPI` as an opaque object type rather than a
// `Record<string, unknown>` so the real media API type (with named methods, no
// index signature) can be assigned to it without the structural mismatch
// flagged by TS2322.
type PluginMediaAPI = object
type CanonicalExtensionPoint = string

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
  | "wasm" // WASM Component Model plugin (wasmtime host, Tauri-only — ADR 0013)
  | "vscode-extension" // VS Code extension running in Node sidecar (Tauri-only — see ~/.claude/plans/vscode-snug-squid.md)

/**
 * Runtime that executes a module-bridge contribution's factory.
 *
 * Resolution order (see `effectiveContributionBackend` in
 * `lib/plugin/core/validation.ts` and `isPythonBackedContribution` in
 * `lib/plugin/bridge/_shared/python-backed-proxy.ts` — all three are kept
 * rule-for-rule in lockstep with the Rust lint):
 *   1. this explicit field;
 *   2. a declared JS module path (`entry`) — writing one *is* the declaration
 *      of JS intent, so it is never silently ignored;
 *   3. the plugin type (`python` → `"python"`, everything else → `"js"`).
 *
 * `hybrid` plugins should set this explicitly: an omitted backend resolves to
 * `"js"`, which is rarely what a hybrid author means for a Python handler.
 * Only capabilities whose contract marks `pythonExecution` as
 * `supported`/`experimental` may resolve to `"python"`.
 */
export type PluginContributionBackend = "js" | "python"

/**
 * Plugin capabilities - what the plugin can provide
 */
export type PluginCapability =
  | "tools" // Provides Agent tools
  | "native-anthropic-tool" // Wraps an Anthropic native tool (computer/bash/text_editor)
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
  | "configuration" // Declarative settings schema (auto-rendered form + ctx.configuration)
  | "a2ui" // A2UI integration
  | "python" // Python runtime capability
  | "scheduler" // Provides scheduled tasks
  | "workspace-backend" // Contributes workspace execution backends (sandbox/local runners)
  | "message-renderer" // Contributes per-message-part renderers
  | "tool-renderer" // Contributes result cards for its own MCP tools
  | "density-preset" // Contributes named appearance density presets
  | "chat-middleware" // Contributes guarded chat request middleware
  | "modal-mount" // Contributes declarative modal mount points
  | "terminal-completion" // Contributes terminal inline completion providers
  | "routing-strategy" // Contributes model routing strategies
  | "deployment-filter" // Contributes pre-call deployment filters
  | "protocol-adapter" // Contributes custom provider protocol adapters
  | "tool-route" // Contributes semantic utterance routes for plugin tools
  | "context-provider" // Contributes declarative agent context providers
  | "external-agent-preset" // cognia-next: contributes external-agent presets (Claude Code / Codex / etc.)
  | "external-agent-adapter" // cognia-next: contributes external-agent protocol adapters (new protocols)
  | "session-importer" // cognia-next: contributes external-agent session-history importers (Cursor / Cline / Windsurf / …)
  | "mcp-server-preset" // Contributes MCP server presets to the gallery
  | "connectors" // Provides Platform Connector adapters (Task 110)
  | "integrations" // Provides Marketplace service integrations (events/actions/resources)
  | "workflow" // Contributes custom workflow node executors (ADR 0017)
  | "workflow-trigger" // Contributes custom workflow trigger sources (ADR 0017)
  | "tray" // Contributes items to the desktop system tray menu (ADR-pending)
  | "lsp-server" // Contributes a Language Server (Phase B of LSP reuse)
  | "theme-pack" // Bundles colors + fonts + wallpapers + density into a single applyable pack
  | "fonts" // Contributes font families bundled in plugin assets (@font-face injection)
  | "wallpapers" // Contributes built-in wallpaper entries (bundled images/gradients/colors)
  | "character-pack" // Bundles ready-to-use characters into a portable pack (ADR-0030)
  | "subagent" // Contributes Claude SDK subagents callable by teams + workflow editor
  | "template-package" // Contributes immutable packages to the unified template catalog
  | "agent-team-template" // Contributes complete agent-team blueprints surfaced in the team picker
  | "shared-memory-adapter" // Contributes a bidirectional backing store for agent-team shared memory
  | "workflow-template" // Contributes complete visual-workflow blueprints surfaced in the editor (ADR-0017/0032)
  | "automation" // Drives the desktop via Computer Use (screenshot/click/type/…) — gates ctx.automation
  | "companion" // Manages paired devices + remote-control grants — gates ctx.companion
  | "quick-action" // Contributes quick actions surfaced in the command palette / composer menu / tray
  | "cli-tools" // Declaratively wraps external CLI binaries as agent tools (manifest.cliTools)
  | "balance-adapter" // Contributes a subscription balance adapter (Usage balance cards / /balance)
  | "limits-source" // Contributes a unified subscription limits/usage source (Usage tab / TUI /limits)
  | "im-rate-source" // Contributes a per-conversation IM send gate (connector runtime ai-run branch)
  | "compaction-strategy" // Contributes a conversation-compaction strategy (summary prompt + thresholds)
  | "view-container" // Contributes a rail-mounted view container (B1) — own icon + middle-column panel
  | "tree-view" // Contributes tree data providers / custom React views (B2) mounted into a view container
  | "webview" // Contributes sandboxed HTML webview panels (B3) mounted into a view container
  | "context-panel" // Contributes resource-scoped trusted React panels to the Context Workbench
  | "auth-provider" // Contributes a native auth/OAuth provider (C1) — ctx.auth.registerProvider
  | "uri-handler" // Handles cognia://plugin/<id>/... deep-links (C2) — ctx.uri.registerHandler
  | "editor" // Drives the live project editor — gates ctx.editor (engine-agnostic: Monaco or the code-server Pro IDE)
  | "pet" // Reads + nurtures the desktop pet — gates ctx.pet (rate-limited, budget-clamped)
  | "pet-achievement" // Contributes data-only pet achievements (condition DSL, manifest.petAchievements)
  | "pet-item" // Contributes data-only pet shop items (manifest.petItems)

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
  | "suspended" // Idle-suspended: contributions torn down, user-enabled intent preserved
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

export type PluginRuntimeProfile = "browser" | "tauri" | "mobile" | "headless"

export type PluginRuntimeAvailability = "supported" | "degraded" | "blocked"

export interface PluginRuntimeCompatibilityTarget {
  availability: PluginRuntimeAvailability
  reason?: string
  entrypoint?: string
}

export interface PluginRuntimeCompatibilityMap {
  browser?: PluginRuntimeCompatibilityTarget
  tauri?: PluginRuntimeCompatibilityTarget
  /**
   * Node brain plus cognia-server native hosts. Legacy manifests inherit the
   * browser target for renderer-style frontend plugins and the Tauri target
   * for Node/native plugin types; new packages should declare this explicitly.
   */
  headless?: PluginRuntimeCompatibilityTarget
  /**
   * Capacitor mobile (WebView) shell. A browser-class runtime that lacks the
   * Tauri invoke bridge, Node sidecar, desktop automation, and several WebView
   * APIs (screen capture, native clipboard, unrestricted filesystem). When a
   * plugin omits this key the host falls back to {@link browser} availability.
   */
  mobile?: PluginRuntimeCompatibilityTarget
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
  "install" | "update" | "enable" | "disable" | "reload" | "rollback" | "uninstall" | "configure"

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
    wasmMain?: string
    vscodeMain?: string
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
export type PluginPermission = CanonicalPluginPermission

export type PluginPermissionDecision = "allow" | "deny"
export type PluginPermissionPolicy = "ask" | "allow" | "deny"

// =============================================================================
// Plugin Manifest
// =============================================================================

/**
 * A single external binary a plugin needs on the host machine. Declared
 * under `manifest.requires.binaries[]`. The pre-install chain probes
 * each via `detect_binary` and blocks the install (with a deep-linked
 * dialog) when a required binary is missing.
 */
export interface PluginBinaryRequirement {
  /** Executable name as it appears on PATH — e.g. "cognia", "git". */
  name: string
  /** Optional minimum semver. When absent, presence alone satisfies it. */
  minVersion?: string
  /** Optional URL the missing-binary dialog deep-links to for install help. */
  documentation?: string
}

/**
 * Per-plugin fault-tolerance policy for the resilience layer
 * (`lib/plugin/resilience/`). All fields optional — unset values fall back to
 * the global `DEFAULT_PLUGIN_RESILIENCE` defaults. Retry is OFF by default and
 * must be explicitly opted in (per manifest or per tool) so non-idempotent
 * tools are never silently re-executed.
 */
export interface PluginResilienceConfig {
  /** Per-attempt wall-clock budget for tool execution (ms). Default 30_000. */
  timeoutMs?: number
  /** Extra attempts after the first. Only applies when `retryable` is true. Default 0. */
  maxRetries?: number
  /** Manifest-wide retry opt-in. Default false. A tool's own `retryable` overrides this. */
  retryable?: boolean
  /** Circuit-breaker scope: per-tool (default) or aggregated per-plugin. */
  breakerScope?: "tool" | "plugin"
  /** Circuit-breaker tuning. */
  breaker?: {
    /** Consecutive failures that open the breaker. Default 5. */
    failureThreshold?: number
    /** Time the breaker stays open before a half-open probe (ms). Default 30_000. */
    cooldownMs?: number
    /** Half-open successes needed to close. Default 2. */
    successThreshold?: number
  }
}

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
    /**
     * Base64-encoded Ed25519 public key (32 bytes raw → 44 char base64).
     * Required for WASM plugins distributed via HTTP/Git so the host can
     * verify the `<bundle>.sig` detached signature before install.
     */
    publicKey?: string
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

  /**
   * Entry point for a WASM Component Model plugin (`.wasm` file, relative to
   * the plugin install root). Required when `type === "wasm"`. The Rust host
   * loads this via `wasmtime::component::Component::from_file`.
   */
  wasmMain?: string

  /**
   * WASM-plugin-only block. Carries runtime tunables and capability hints the
   * host needs at instantiate time. The `cognia:api-version` value is also
   * embedded as a custom section in the `.wasm` itself; this field exists for
   * the manifest preview UI and as a sanity check before instantiation.
   */
  wasm?: {
    /** Semver of the WIT contract this plugin was built against (e.g. "0.1.0"). */
    apiVersion: string
    /** Linear-memory cap in MiB. Defaults to 64. Host-enforced via `StoreLimits`. */
    memoryLimitMb?: number
    /** Per-call wall-clock timeout in milliseconds. Defaults to 30000. */
    callTimeoutMs?: number
    /**
     * Additional filesystem preopens the plugin needs beyond its own
     * `<app_data>/cognia/plugins/<id>/` data dir. Each entry is granted at
     * install time via the capability sheet; un-granted entries are dropped.
     */
    fs?: {
      preopens?: string[]
    }
  }

  /**
   * Entry point for a VS Code extension (relative path to the bundle inside
   * the unpacked `.vsix`, e.g. `extension/out/extension.js`). Required when
   * `type === "vscode-extension"`. The Node sidecar
   * (`sidecar/vscode-ext-host/`) loads this via a `vm.createContext`
   * sandbox after the `require("vscode")` hook is installed.
   */
  vscodeMain?: string

  /**
   * VS Code-extension-only block. Carries the originating VS Code metadata
   * so the host can re-derive contribution details without re-parsing the
   * `.vsix`. Populated by `lib/plugin/vscode-shim/manifest-adapter.ts` at
   * install time. See `types/plugin/plugin-vscode.ts:VsCodeExtensionBlock`.
   */
  vscodeExtension?: VsCodeExtensionBlock

  /**
   * Versioned, engine-neutral IDE contribution contract. The host normalizes
   * this block before projecting it to Monaco or a managed code-server proxy.
   */
  ide?: PluginIdeManifest

  /**
   * VS Code `contributes.languages[]` projected onto the cognia manifest at
   * install time (`manifest-adapter.ts`). The plugin manager registers these
   * through `languages-bridge` on enable so contributed language ids surface
   * in Monaco (`monaco.languages.register` + `setLanguageConfiguration`) and
   * cognia's filename → language detection. See ADR-0026 (VS Code reuse layer)
   * and `docs/.../plugin-system`.
   */
  vscodeLanguages?: VsCodeLanguage[]

  /**
   * VS Code `contributes.grammars[]` projected onto the manifest at install
   * time (W5.1). Registered through `grammars-bridge` on enable; the shiki
   * highlight seam consumes registered TextMate grammars for contributed
   * languages. Paths are relative to the plugin root.
   */
  vscodeGrammars?: Array<{ scopeName: string; language?: string; path: string }>

  /**
   * VS Code `contributes.iconThemes[]` projected onto the manifest at install
   * time (W5.1). Registered through `icons-bridge` on enable; the project
   * file tree resolves file icons from the active contributed theme.
   */
  vscodeIconThemes?: Array<{ id: string; label: string; path: string }>

  /**
   * VS Code `contributes.snippets[]` projected onto the manifest at install
   * time (W5.1). Registered through `snippets-bridge` on enable; the Monaco
   * completion source (`lib/monaco/snippets.ts`) already reads the bridge.
   */
  vscodeSnippets?: Array<{ language: string; path: string }>

  /** Style entry point (CSS) */
  styles?: string

  // Dependencies
  /**
   * Required plugin dependencies (`pluginId` → semver constraint). A missing,
   * disabled, or version-mismatched required dependency BLOCKS this plugin
   * from enabling (see `lib/plugin/core/load-order.ts`).
   */
  dependencies?: Record<string, string>

  /**
   * Optional plugin dependencies (`pluginId` → semver constraint). An unmet
   * optional dependency does NOT block enabling — the plugin loads in a
   * degraded mode and is expected to feature-gate internally.
   */
  optionalDependencies?: Record<string, string>

  /** Runtime services published after activation + contribution commit. */
  providesServices?: Record<string, string>

  /** Runtime services required before activate() may run. */
  requiresServices?: Record<string, string>

  /** Runtime services that enable optional features without blocking activation. */
  optionalServices?: Record<string, string>

  /** Built-in skill ids/families this plugin may invoke (for example `lark.sheets.*`). */
  builtInSkills?: string[]

  /** Host application version requirements */
  engines?: {
    cognia?: string
    node?: string
    python?: string
  }

  /**
   * External tooling the plugin needs on the host machine to install or
   * run — e.g. the `cognia` CLI for an author bundle, `git` for a repo
   * plugin, `cargo-component` for a WASM build. The marketplace
   * pre-install chain probes each entry (via the `detect_binary` Tauri
   * command) and, when any is missing, surfaces a dialog deep-linking to
   * `documentation` before letting the install proceed.
   *
   * Optional and additive — a plugin that declares nothing here installs
   * exactly as before.
   */
  requires?: {
    binaries?: PluginBinaryRequirement[]
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

  /** Fault-tolerance policy (timeout/retry/circuit-breaker) for this plugin. */
  resilience?: PluginResilienceConfig

  /** Default configuration values */
  defaultConfig?: Record<string, unknown>

  // Permissions
  /** Required permissions */
  permissions?: PluginPermission[]

  /** Optional permissions (requested at runtime) */
  optionalPermissions?: PluginPermission[]

  /**
   * Concrete filesystem scope for Node-target JavaScript plugins. The host
   * only converts these paths into Node `--allow-fs-*` flags when the matching
   * `filesystem:*` permission is also declared; missing or empty lists deny by
   * default.
   */
  fileScope?: {
    readPaths?: string[]
    writePaths?: string[]
  }

  /**
   * Declarative allowlist of shell programs this plugin may run via
   * `ctx.shell.execute` (program names, e.g. `["git", "node"]`). The host
   * enforces this deny-by-default: a plugin holding `shell:execute` can only
   * run a command listed here. Omitting it (or an empty list) means the plugin
   * can run NO command even with the permission granted.
   */
  shellCommands?: string[]

  /**
   * Declarative network egress policy. `allowedDomains` preserves the legacy
   * domain-only form; `rules` additionally constrains HTTP method and path so
   * read-only plugins can be enforced by the host. Omitting `networkAccess`
   * denies network egress even when `network:fetch` is granted.
   */
  networkAccess?: {
    allowedDomains?: string[]
    rules?: PluginNetworkAccessRule[]
    /** Why the plugin needs the declared access — shown in the consent prompt. */
    reasoning?: string
  }

  /**
   * Per-permission justification strings — surfaced verbatim in the
   * permission-review dialog so the user understands why the plugin needs
   * each scope. Keyed by permission id. Optional; missing entries fall back
   * to the canonical `PERMISSION_DESCRIPTIONS` text from
   * `lib/plugin/security/permission-guard.ts`.
   */
  permissionJustifications?: Partial<Record<PluginPermission, string>>

  // A2UI Integration
  /** Custom A2UI components provided */
  a2uiComponents?: A2UIPluginComponentDef[]

  /** A2UI surface templates provided */
  a2uiTemplates?: A2UITemplateDef[]

  // Agent Integration
  /** Agent tools provided */
  tools?: PluginToolDef[]

  /**
   * Declarative CLI wrapper tools — external binaries exposed as agent
   * tools with zero plugin code. Requires the `"cli-tools"` capability and
   * the `"cli:execute"` permission (DANGEROUS, confirm-tier).
   */
  cliTools?: PluginCliToolDef[]

  /** Agent modes provided */
  modes?: PluginModeDef[]

  /** Slash commands provided */
  commands?: PluginManifestCommandDef[]

  /**
   * Quick actions surfaced in the command palette / composer menu / tray.
   * Requires the `"quick-action"` capability. Each entry must name a
   * dispatch target (`command` or `slash`).
   */
  quickActions?: PluginQuickActionDef[]

  /**
   * Declarative native tray items. Requires the `"tray"` capability and a
   * dispatch target (`command` or `slash`).
   */
  trayItems?: PluginManifestTrayItemDef[]

  // Activation
  /** Activation events - when to load the plugin */
  activationEvents?: PluginActivationEvent[]

  /**
   * React components contributed to canonical host UI extension points.
   * The host derives `onView:<point>` activation events from these entries.
   */
  extensions?: PluginExtensionDef[]

  /** Whether plugin should be loaded at startup */
  activateOnStartup?: boolean

  /**
   * Opt in to host idle-suspension: when true, the host may tear the plugin's
   * contributions down after it has been idle past the threshold (reclaiming
   * resources) and transparently resume it on the next activation event. Off by
   * default — never auto-suspend startup/connector/scheduler plugins.
   */
  idleSuspend?: boolean

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

  /**
   * Marketplace service integrations. Unlike connectors, these model external
   * resources, webhook events, typed actions, and optional Inbox projections.
   */
  integrations?: PluginIntegrationDef[]
  /** One-major compatibility aliases resolved only while this plugin is enabled. */
  workflowKindAliases?: Record<string, string>

  // Plugin-first Computer Use plumbing (M1·T1)
  /** MCP server presets contributed by this plugin (mcp-server-preset capability). */
  mcpServerPresets?: PluginMcpServerPresetDef[]
  /** Anthropic native tool definitions contributed by this plugin (native-anthropic-tool capability). */
  nativeAnthropicTools?: PluginNativeAnthropicToolDef[]
  /** Agent skills contributed by this plugin (skills capability — unblocked in M1). */
  skills?: PluginSkillDef[]
  /** External-agent presets — backfill: contract declares this field at plugin-capabilities.ts:346 but the manifest type doesn't expose it yet. */
  externalAgentPresets?: PluginExternalAgentPresetDef[]
  /**
   * Character packs contributed by this plugin (character-pack capability — ADR-0030).
   * Each pack bundles one or more `PluginCharacterDef`s with optional cross-capability
   * dependencies (skills / mcp-presets / native-tools). Registered overlay-only on
   * enable, dropped on disable; user-edited clones live in Dexie and survive plugin
   * lifecycle. See `lib/plugin/registries/character-pack-registry.ts`.
   */
  characterPacks?: PluginCharacterPackDef[]
  /**
   * Data-only pet achievements (`pet-achievement` capability). Compiled from
   * their condition DSL into predicates at check time; ids namespace as
   * `plugin:<pluginId>:<id>`. See `lib/plugin/registries/pet-achievement-registry.ts`.
   */
  petAchievements?: import("./plugin-pet").PluginPetAchievementDef[]
  /**
   * Data-only pet shop items (`pet-item` capability), unioned into the host
   * catalog static-first. See `lib/plugin/registries/pet-item-registry.ts`.
   */
  petItems?: import("./plugin-pet").PluginPetItemDef[]
  /**
   * Subagents contributed by this plugin (`subagent` capability). Each entry
   * mirrors the Claude Code SDK `AgentDefinition` shape and is registered
   * into `subagent-registry` on enable. Teams and the workflow editor union
   * the overlay with the host's 4 bundled subagents via
   * `lib/claude/agents/subagents/index.ts:resolveAllSubagents`. Plugin
   * subagent names are namespaced as `<pluginId>:<id>` at projection time so
   * they never collide with built-in dispatcher names.
   */
  subagents?: import("./plugin-subagent").PluginSubagentDef[]
  /**
   * Immutable unified template packages (`template-package` capability).
   * Definitions are overlay-only and are removed with the plugin lifecycle.
   */
  templatePackages?: import("@/packages/plugin-sdk/src/templates").PluginTemplatePackageContribution[]
  /**
   * Agent team templates contributed by this plugin (`agent-team-template`
   * capability). Each template carries a roster of teammates, optional
   * pre-seeded tasks, default config overrides, and a `requires` block
   * declaring cross-capability dependencies. Missing dependencies become
   * non-blocking warnings surfaced as disabled badges in the team picker
   * (mirrors the ADR-0030 character-pack `requires` pattern).
   */
  agentTeamTemplates?: import("./plugin-agent-team-template").PluginAgentTeamTemplateDef[]
  /**
   * Shared-memory adapters contributed by this plugin (`shared-memory-adapter`
   * capability). Each adapter mirrors an agent-team's shared-memory KV into an
   * external backing store (Notion / Lark Wiki / sqlite / …) and can pull
   * remote changes back. A team opts into a single adapter via
   * `team.config.sharedMemoryAdapterId`. Registered into
   * `shared-memory-adapter-registry` on enable.
   */
  sharedMemoryAdapters?: import("./plugin-shared-memory-adapter").PluginSharedMemoryAdapterDef[]

  /**
   * Subscription balance adapters contributed by this plugin
   * (`balance-adapter` capability). Each adapter resolves "how much credit /
   * quota is left" for a provider account from a pure authed GET; registered
   * into `balance-adapter-registry` on enable and consulted by
   * `findBalanceAdapter` ahead of the built-in adapters.
   */
  balanceAdapters?: import("./plugin-balance-adapter").PluginBalanceAdapterDef[]

  /**
   * Unified subscription limits/usage sources contributed by this plugin
   * (`limits-source` capability). Each source resolves normalized
   * `ProviderLimits` (utilization windows and/or credit meters) for a provider
   * account; registered into `limits-source-registry` on enable and consulted
   * by `resolveLimitsSources` ahead of the built-in sources.
   */
  limitsSources?: import("./plugin-limits-source").PluginLimitsSourceDef[]

  /**
   * Per-conversation IM send gates contributed by this plugin
   * (`im-rate-source` capability). Each source decides whether an
   * inbound-triggered AI reply may proceed for a conversation; registered into
   * `im-rate-source-registry` on enable and consulted by `evaluateImRate` at
   * the top of the connector runtime's ai-run branch (advisory/additive).
   */
  imRateSources?: import("./plugin-im-rate-source").PluginImRateSourceDef[]

  /**
   * Conversation-compaction strategies contributed by this plugin
   * (`compaction-strategy` capability). Each strategy declaratively carries a
   * summary prompt and/or threshold knobs; registered into
   * `compaction-strategy-registry` on enable and resolved by
   * `resolveSendOptions` when the compaction settings select its id.
   */
  compactionStrategies?: import("./plugin-compaction-strategy").PluginCompactionStrategyDef[]

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

  /**
   * Complete visual-workflow blueprints contributed by this plugin
   * (`workflow-template` capability). Registered into the
   * `workflow-template-registry` overlay on enable and surfaced in the editor's
   * Settings tab → "Plugins & capabilities". Each entry's `requires` block
   * declares cross-capability dependencies (mirrors `agentTeamTemplates`).
   */
  workflowTemplates?: import("./plugin-workflow-template").PluginWorkflowTemplateDef[]

  /**
   * Language Server Protocol servers contributed by this plugin (Phase B
   * of the VS Code LSP reuse work — see
   * `~/.claude/plans/vscode-lsp-mighty-robin.md`). Each entry declares an
   * executable + arguments + the Monaco language ids it serves. The
   * host's `lib/plugin/lsp/lsp-registry.ts` spawns and tears down each
   * server in lock-step with plugin enable/disable, gates the spawn
   * through `lsp-binary-policy`, and wires the server's diagnostics +
   * provider responses through the existing monaco-bridge.
   *
   * Distinct from the `.vsix`-bundled LSP path (Phase A): a plugin
   * contributing `lspServers` does NOT need to ship a VS Code
   * extension wrapper — cognia spawns the LSP directly.
   *
   * The `lsp-server` capability must be present in `capabilities[]`.
   */
  lspServers?: PluginLspServerDef[]

  /**
   * Plugin-declared Dexie (IndexedDB) tables. The host's
   * `lib/plugin/dexie-bridge.ts` aggregates declarations across all enabled
   * plugins and bumps the shared CogniaDB schema once on plugin enable.
   * Tables are namespaced as `<pluginId>:<tableName>` to prevent collisions.
   * Plugins access their tables via `ctx.dexie.table<T>(name)`.
   */
  dexie?: PluginManifestDexieBlock

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

  /**
   * Theme packs — a single applyable bundle of (theme + font + wallpaper +
   * density + radius + motion-speed + monaco theme). Each entry references
   * other contributions by id, so packs do not duplicate the underlying
   * assets. See `lib/plugin/bridge/themes-bridge.ts` for the apply path.
   *
   * v47 (ADR-0030).
   */
  themePacks?: PluginThemePackContribution[]

  /**
   * Font families bundled inside the plugin's `assets/` directory. The host
   * font-bridge generates `@font-face` declarations on enable and removes
   * them on disable. File bytes are validated against woff2/ttf/otf magic
   * before injection. v47 (ADR-0030).
   */
  fonts?: PluginFontContribution[]

  /**
   * Bundled wallpapers (built-in entries that appear in the wallpaper
   * gallery while the plugin is enabled). User-uploaded wallpapers are
   * never touched by enable/disable. v47 (ADR-0030).
   */
  wallpapers?: PluginWallpaperContribution[]

  /**
   * Named density tuples that callers can refer to from `themePacks[i].applies.density`.
   * Plugins may also override the host defaults with the canonical names
   * (`compact` / `comfortable` / `spacious`) — the bridge logs a warning but
   * does not reject. v47 (ADR-0030).
   */
  densityPresets?: PluginDensityPresetContribution[]

  /**
   * Optional localized strings shipped by the plugin. Keys are merged into
   * the host's next-intl bundle under the `plugin.<id>.` prefix so plugins
   * cannot collide with the host namespace; plugin code calls
   * `t("plugin.<id>.<key>")` to consume them.
   *
   * Validation rules enforced in `lib/plugin/core/validation.ts`:
   *   - Each locale must be one of the host's canonical locales.
   *   - Each value must be a flat `Record<string, string>` (no nested
   *     objects, no arrays) so the runtime merge is O(n) and predictable.
   *   - Keys must match `^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$`.
   *   - Max 1000 keys per locale.
   */
  i18n?: {
    locales: Partial<Record<string, Record<string, string>>>
  }

  // ---------------------------------------------------------------------------
  // Extension-point v2 (ADR-0026) — declarative provider / renderer / mount /
  // middleware contributions. Each entry follows the lazy-factory pattern
  // (`entry` = relative path to the plugin's module, `export` = named factory
  // function). The host dynamic-imports on first use; plugins should keep
  // module-level work in the entry file minimal.
  // ---------------------------------------------------------------------------

  /**
   * OCR providers contributed by this plugin. Registered with
   * `lib/ocr/registry.ts` via `lib/plugin/bridge/ocr-providers-bridge.ts` on
   * plugin enable; auto-unregistered on disable. Permission gate:
   * `network:fetch` (+ optional `media:image:read`).
   */
  ocrProviders?: PluginOcrProviderDef[]

  /**
   * Workspace execution backends contributed by this plugin (issue-loop /
   * sandbox runners). Registered with the workspace-backend-registry under
   * `<pluginId>:<id>`; the host resolves them by kind. Permission gate:
   * `process:spawn` + `filesystem:write`.
   */
  workspaceBackends?: PluginWorkspaceBackendDef[]

  /**
   * Per-part message renderers contributed by this plugin. The host owns
   * message chrome (select / copy / regenerate) — plugins only contribute
   * the inner React node for unknown `part.type` values. Registered with
   * `lib/plugin/api/message-part-renderers.ts`. Permission gate:
   * `extension:ui`.
   */
  messageRenderers?: PluginMessageRendererDef[]

  /**
   * Result cards for MCP tools this plugin provides. Tool parts are host-owned
   * (`tool-*` / `dynamic-tool` never reach the message-part registry), so this
   * is the declarative seam for rendering a plugin tool's output richly instead
   * of falling through to the generic content-blocks card. Registered with
   * `lib/plugin/api/tool-result-renderers.ts`. Permission gate: `extension:ui`.
   */
  toolRenderers?: PluginToolRendererDef[]

  /**
   * Plugin-internal AI providers (LLM completion + embedding). Strictly NOT
   * a replacement for the main chat backend — the chat pipeline always
   * resolves through Claude Code SDK. Plugins call `ctx.ai.complete()` /
   * `ctx.ai.embed()` for their own background tasks. Permission gate:
   * `network:fetch` + `secrets:read`.
   */
  aiProviders?: PluginAiProviderDef[]

  /**
   * Copilot-style terminal completion providers contributed by this plugin
   * (ADR-0039). Lazy `{ id, label, entry, export }` factories; registered
   * with the terminal completion registry via
   * `lib/plugin/bridge/terminal-completion-bridge.ts` on plugin enable and
   * auto-unregistered on disable. Suggestions feed the integrated
   * terminal's inline ghost text. Permission gate: `terminal:completion`.
   */
  terminalCompletionProviders?: PluginTerminalCompletionProviderDef[]

  /**
   * Modal mounts that the host can open by id (declarative + deep-linkable).
   * Imperative `ctx.modal.openModal()` works for ad-hoc modals without a
   * manifest entry. Permission gate: `extension:ui`.
   */
  modalMounts?: PluginModalMountDef[]

  /**
   * Custom view containers (B1) — rail-mounted destinations that swap the
   * middle column to a plugin-owned panel hosting the plugin's views.
   * Registered via the `view-container` overlay capability on enable and
   * auto-unregistered on disable. Permission gate: `extension:ui`.
   */
  viewsContainers?: PluginViewContainerDef[]

  /**
   * Tree data providers / custom React views (B2) mounted into the plugin's
   * view containers. Lazy `{ id, containerId, type, entry, export }` factories
   * resolved by `lib/plugin/bridge/view-bridge.ts` on enable and dropped on
   * disable. Permission gate: `extension:ui`.
   */
  views?: PluginViewDef[]

  /**
   * Resource-scoped trusted React panels mounted in the shared Context
   * Workbench. Lazy `{ id, entry, export }` modules; sandboxed webviews are
   * deliberately excluded from this surface. Permission gate:
   * `extension:ui` plus the read permission for every declared resource kind.
   */
  contextPanels?: PluginContextPanelDef[]

  /**
   * Sandboxed webview panels (B3) — arbitrary HTML rendered in an isolated
   * `<iframe sandbox="allow-scripts">` mounted into a view container. Resolved
   * by `lib/plugin/bridge/plugin-webview-bridge.ts` on enable; the CSP is
   * derived from `networkAccess.allowedDomains`. Permission gate: `extension:ui`.
   */
  webviews?: PluginWebviewDef[]

  /**
   * Native auth/OAuth providers (C1). Declarative `{ id, label }` for
   * validation + the consent UI; the live provider object is supplied
   * imperatively via `ctx.auth.registerProvider` at activation. Registered
   * into the auth-provider registry on enable and dropped on disable.
   * Permission gate: `auth:provide`.
   */
  authProviders?: PluginAuthProviderDef[]

  /**
   * Around-style chat middleware. Each middleware wraps the build-options +
   * send pipeline; the runner enforces per-middleware timeout, error
   * isolation, and a 3-strike circuit breaker that disables the plugin on
   * repeated failure. Permission gate: closest existing `chat:hooks`-style
   * key (see ADR-0026 §4).
   */
  chatMiddlewares?: PluginChatMiddlewareDef[]

  /**
   * Plugin-contributed provider routing strategies (LiteLLM
   * CustomRoutingStrategy analog). ADR-0026 lazy-factory entries
   * registered into the routing strategy registry on enable under the
   * namespaced id `${pluginId}:${id}` (`routing-strategy` capability,
   * field-driven module bridge).
   */
  routingStrategies?: PluginRoutingStrategyDef[]

  /**
   * Plugin-contributed pre-call deployment filters (LiteLLM
   * optional_pre_call_checks analog). ADR-0026 lazy-factory entries
   * registered into the deployment-filter registry on enable under the
   * namespaced id `${pluginId}:${id}` (`deployment-filter` capability,
   * field-driven module bridge). Users opt them into the routing
   * chain via `RoutingConfig.filterChain`.
   */
  deploymentFilters?: PluginDeploymentFilterDef[]

  /**
   * Plugin-contributed outbound protocol adapters: declarative
   * `openai-compatible-variant` specs registered under `${pluginId}:${id}`
   * and forwarded to the sidecar per-send (`protocol-adapter` capability,
   * field-driven module bridge). Pure data; no plugin code ever loads
   * into the sidecar process.
   */
  protocolAdapters?: PluginProtocolAdapterDef[]

  /**
   * External-agent protocol adapters (`external-agent-adapter` capability).
   * Each entry lazy-imports a `() => ProtocolAdapter` factory on enable and
   * registers it into the external-agent `protocolAdapterRegistry` under the
   * namespaced protocol id `${pluginId}:${id}` (`external-agent-adapter`
   * capability, field-driven module bridge). Lets a plugin contribute a
   * genuinely new external-agent
   * protocol, not just a preset over a built-in one.
   */
  externalAgentAdapters?: PluginExternalAgentAdapterDef[]

  /**
   * External-agent SESSION IMPORTERS (`session-importer` capability, ADR-0062).
   * Each entry lazy-imports a `() => AgentSessionSourceAdapter` factory on enable
   * and registers it into the session-source registry under the namespaced id
   * `${pluginId}:${id}`. Lets a plugin add a new agent's on-disk session-history
   * importer (Cursor, Cline, Windsurf, …) with no host change — field-driven
   * module bridge, mirroring `externalAgentAdapters`.
   */
  sessionImporters?: PluginSessionImporterDef[]

  /**
   * Semantic tool routes: example utterances attached to this plugin's
   * tools, persisted into the `toolRoutes` table on enable and consumed
   * by the opt-in semantic tool-routing matcher (`tool-route` capability,
   * field-driven module bridge).
   */
  toolRoutes?: PluginToolRouteDef[]

  /**
   * Plugin-contributed agent context providers (ADR-0026 Package E). Lazy-
   * factory entries registered into the context-provider registry on enable
   * under the namespaced id `${pluginId}:${id}` (`context-provider` capability,
   * field-driven module bridge). Each provider's `provide()` output is
   * appended to the system prompt of the plugin's agent runs. This is the
   * declarative counterpart to `ctx.agent.context.registerProvider`.
   */
  contextProviders?: PluginContextProviderDef[]

  /**
   * Optional custom settings UI component. When present, the host renders
   * `<component {...}/>` in the per-plugin settings panel *instead of* the
   * generic JSON-schema-driven form (which is still derived from
   * `configSchema`). Useful for plugins whose configuration is too rich for
   * a flat form (file pickers, OAuth flows, live previews).
   *
   * `entry` is a relative path under the plugin install root and `export`
   * is the named React export — same lazy-factory shape used by every
   * other v2 contribution. ADR-0026 §3 §B.
   */
  configComponent?: {
    entry: string
    export: string
  }
}

/**
 * One theme entry inside `PluginManifest.themes`. Plugins may either inline
 * a full ThemeColors object or point at a VSCode `.json` file shipped with
 * the plugin. The bridge uses path-traversal guards on `vscodeJsonPath`.
 *
 * Note: `ThemeColors` is defined further down in this module; we use a
 * structural alias here to keep the manifest surface free of the deeper
 * runtime dependencies (`Skill`, the agent-mode chain, the canvas APIs) that
 * the full API interfaces pull in. The bridge enforces the full shape at
 * runtime.
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
   * ADR-0026 §3 §D — CSS custom-property overrides applied as a scoped
   * `<style data-plugin-theme="<pluginId>">` block when the theme is
   * activated. Values are constrained to CSS custom properties (variable
   * names matching `^--[a-z][a-z0-9-]*$` and bounded length) — no full
   * CSS string injection is allowed, to keep the surface auditable.
   */
  | {
      id: string
      name: string
      isDark?: boolean
      cssVariables: Record<string, string>
    }

// ----------------------------------------------------------------------------
// v47 — Theme Packs / Fonts / Wallpapers / Density Presets (ADR-0030)
// ----------------------------------------------------------------------------

/**
 * A single applyable bundle. References sibling contributions in the same
 * manifest by id (`themeId` → one of `manifest.themes[i].id`,
 * `fontFamily` → `manifest.fonts[i].family`, `wallpaperId` → `manifest.wallpapers[i].id`,
 * `densityPresetName` → `manifest.densityPresets[i].name`). All `applies`
 * fields are optional — a pack may e.g. ship only fonts + wallpaper.
 */
export interface PluginThemePackContribution {
  id: string
  name: string
  description?: string
  /** Optional preview images (data-url or relative asset path). */
  preview?: { light?: string; dark?: string }
  applies: {
    /** References `manifest.themes[i].id` or a host preset key. */
    themeId?: string
    fontFamily?: string
    monoFamily?: string
    serifFamily?: string
    wallpaperId?: string
    /** Either a canonical density level or a name from `manifest.densityPresets`. */
    density?: "compact" | "comfortable" | "spacious" | string
    /** Base radius in rem; clamped to 0..1.5 by the applier. */
    radius?: number
    motionSpeed?: 0.5 | 1 | 1.5
    /**
     * Monaco theme id (defaults to the same as `themeId` when both are
     * VSCode-imported); set explicitly to decouple Monaco from the app theme.
     */
    monacoTheme?: string
  }
}

/**
 * Plugin-bundled font family. `files[]` lists per-weight/style faces; each
 * `src` is a path under the plugin's install root. The font-bridge resolves
 * to `file://` or `asset://` at runtime depending on host capability.
 */
export interface PluginFontContribution {
  /** CSS family name. Must be unique within the plugin's contributions. */
  family: string
  files: PluginFontFile[]
  display?: "swap" | "block" | "fallback" | "optional" | "auto"
  unicodeRange?: string
}

export interface PluginFontFile {
  weight: number
  style?: "normal" | "italic"
  /** Relative path under the plugin install root, e.g. `assets/Inter-Regular.woff2`. */
  src: string
}

export interface PluginWallpaperContribution {
  id: string
  name: string
  /** Bundled source — image:disk (relative path) or color/gradient inline. */
  source:
    | {
        kind: "image"
        /** Relative path under the plugin install root, e.g. `assets/wp.jpg`. */
        relPath: string
        mime: string
        width: number
        height: number
      }
    | { kind: "gradient"; css: string }
    | { kind: "color"; value: string }
}

export interface PluginDensityPresetContribution {
  /** Bare name — referenced by `PluginThemePackContribution.applies.density`. */
  name: string
  /** Override of host CSS custom properties; values are passed through verbatim. */
  vars: {
    "--density-spacing"?: string
    "--density-input-height"?: string
    "--density-row-padding"?: string
    "--density-gap"?: string
    "--density-line-height"?: string
  }
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
 * One external-agent preset definition inside `PluginManifest.externalAgentPresets`.
 *
 * Adds a registry `id` on top of `ExternalAgentPresetConfig` (the shape used
 * inside `lib/ai/agent/external/presets.ts`, which keys presets by id rather
 * than carrying the id inline). The plugin manager passes `(id, config)` into
 * `presets.registerPreset` on enable and removes them on disable.
 */
export interface PluginExternalAgentPresetDef extends ExternalAgentPresetConfig {
  /** Stable id used as the registry key (e.g. "claude-code", "codex"). */
  id: string
}

/**
 * One Language Server contribution inside `PluginManifest.lspServers`.
 *
 * Each entry produces a `CogniaLspClient` (`sidecar/vscode-ext-host/src/
 * lsp-client.ts`) wrapped with the standard LSP↔Monaco type-conversion
 * layer. The host materialises a per-surface workspace (via
 * `lsp-workspace-manager`) when the LSP's first document opens.
 */
export type PluginLspServerDef = LspServerConfig

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

/**
 * VS Code-style configuration scope. Advisory today (cognia has a single
 * config store per plugin); persisted + validated so a future per-resource
 * override layer can honour it without a schema change.
 */
export type PluginConfigScope = "application" | "machine" | "window" | "resource"

export interface PluginConfigProperty {
  type: "string" | "number" | "integer" | "boolean" | "array" | "object"
  title?: string
  description?: string
  /** Markdown description rendered (sanitised) in place of `description` when set. */
  markdownDescription?: string
  default?: unknown
  enum?: unknown[]
  /**
   * When `true`, the field's value is stored in the OS keyring under the
   * plugin's `plugin:<id>` namespace instead of the plaintext plugin-config
   * store, and is exposed to the plugin only via
   * `ctx.configuration.getSecret(path)` / `hasSecret(path)` (gated by the
   * `secrets:read` permission). Constraints, enforced by
   * `validateConfigSchema` / `validatePluginConfig`:
   *   - Only valid on `type: "string"` fields (Phase 1).
   *   - Incompatible with `default` — a secret must not travel with the
   *     manifest.
   *   - Only supported at the top level of `configSchema.properties`;
   *     nested `object.properties[key].secret` is rejected in Phase 1.
   */
  secret?: boolean
  /** Per-enum-value plain-text descriptions, surfaced beside each option. */
  enumDescriptions?: string[]
  /** Per-enum-value markdown descriptions (takes precedence over enumDescriptions). */
  markdownEnumDescriptions?: string[]
  /** UI sort key within the form (lower first; unset sorts after, then by declaration order). */
  order?: number
  /** Advisory config scope (VS Code parity). */
  scope?: PluginConfigScope
  /** When set, the field renders a deprecation warning carrying this message. */
  deprecationMessage?: string
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  pattern?: string
  /** Custom message shown when a value fails the `pattern` check. */
  patternMessage?: string
  /** Input hint for string fields: render a wider textarea or validate a known format. */
  format?: "email" | "url" | "uri" | "textarea"
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
  icon?: PluginIconName

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
  icon?: PluginIconName

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

  /**
   * Opt this tool into automatic retry on transient failures. Default false —
   * only set it for idempotent tools (re-running has no extra side effect).
   * Overrides the manifest-level `resilience.retryable`.
   */
  retryable?: boolean

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
  icon: PluginIconName

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
  icon?: PluginIconName

  /** Optional slash command aliases */
  aliases?: string[]
}

// =============================================================================
// Quick Actions
// =============================================================================

/** Surfaces a quick action can appear on. Defaults to all three. */
export type PluginQuickActionSurface = "palette" | "composer" | "tray"

/**
 * Declarative quick-action contribution (manifest `quickActions[]`).
 * One registration surfaces in up to three places: the command palette
 * ("Plugin actions" group), the chat composer's quick-actions dropdown,
 * and the tray "All Commands ▶ Plugins" bucket.
 *
 * A quick action IS a command — registration mirrors it into
 * `lib/plugin/commands/registry.ts`, so dispatch (palette select, tray
 * click, shortcut accelerator) reuses `executeCommand` with zero new
 * dispatch rails. Manifest actions must name a dispatch target via
 * `command` (a command-registry id) or `slash` (a slash-command line);
 * imperative registrations may pass a `run` handler instead.
 */
export interface PluginQuickActionDef {
  /** Local id — the host prefixes it with the plugin id. */
  id: string
  /** Display title (literal string, shown verbatim on every surface). */
  title: string
  /** Plugin i18n key preferred over `title` when present for the active locale. */
  labelKey?: string
  /** One-line description shown in the palette. */
  description?: string
  /** Lucide icon name; resolved by the renderer. */
  icon?: PluginIconName
  /** Tray bucket (see `lib/tray/all-commands.ts`). Defaults to "plugins". */
  category?: string
  /** `when` expression evaluated by `lib/tray/when.ts` before rendering. */
  when?: string
  /** Optional keyboard chord bound through the plugin shortcut bridge. */
  accelerator?: string
  /** Dispatch target: a command-registry id to execute. */
  command?: string
  /** Dispatch target: a slash-command line (with or without leading `/`). */
  slash?: string
  /** Surfaces to appear on. Defaults to all three. */
  surfaces?: PluginQuickActionSurface[]
}

/** Imperative registration shape — adds an inline handler option. */
export interface PluginQuickActionInput extends PluginQuickActionDef {
  /** Inline handler; takes precedence over `command` / `slash`. */
  run?: () => void | Promise<void>
}

/**
 * Quick Actions API surfaced via `ctx.quickActions`. Gated on the
 * `"quick-action"` capability — without it every method is a warn-once
 * no-op, mirroring `PluginTrayAPI`.
 */
export interface PluginQuickActionsAPI {
  /** Register one quick action. Returns a disposer. */
  register: (action: PluginQuickActionInput) => () => void
  /** Convenience for multiple actions; the disposer drops all of them. */
  registerMany: (actions: PluginQuickActionInput[]) => () => void
}

// =============================================================================
// Plugin Hooks
// =============================================================================

/**
 * Payload for the `onUpdate` lifecycle hook — the persisted version the host
 * last activated and the version it is loading now.
 */
export interface PluginUpdateInfo {
  fromVersion: string
  toVersion: string
}

/**
 * Hook definitions that plugins can implement
 */
export interface PluginHooks {
  // Lifecycle hooks
  onLoad?: () => Promise<void> | void
  onEnable?: () => Promise<void> | void
  onDisable?: () => Promise<void> | void
  onUnload?: () => Promise<void> | void
  /** Fired once, the first time the plugin successfully loads after install. */
  onInstall?: () => Promise<void> | void
  /** Fired just before the plugin's files are removed — last chance to clean up external state. */
  onUninstall?: () => Promise<void> | void
  /** Fired when a load detects the persisted version changed (carries both versions). */
  onUpdate?: (info: PluginUpdateInfo) => Promise<void> | void
  /** Fired when the host idle-suspends the plugin (contributions torn down, user intent preserved). */
  onSuspend?: () => Promise<void> | void
  /** Fired when a suspended plugin is reactivated by an activation event. */
  onResume?: () => Promise<void> | void
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

  // Agent-Team hooks — dispatched by lib/ai/agent/agent-team-runtime.ts and
  // supporting modules. Complement the generic onAgent* family with team
  // context (teamId / runId) plus governance + consensus + shared-memory +
  // delegation lifecycle events.
  onTeamStart?: (payload: PluginTeamStartPayload) => void
  onTeamPlanReady?: (payload: PluginTeamPlanReadyPayload) => void
  onTeammateClaim?: (payload: PluginTeammateClaimPayload) => void
  onTeammateRelease?: (payload: PluginTeammateReleasePayload) => void
  onTeamBudgetWarn?: (payload: PluginTeamBudgetWarnPayload) => void
  onTeamComplete?: (payload: PluginTeamCompletePayload) => void
  onConsensusOpened?: (payload: PluginConsensusOpenedPayload) => void
  onConsensusVoted?: (payload: PluginConsensusVotedPayload) => void
  onConsensusResolved?: (payload: PluginConsensusResolvedPayload) => void
  onSharedMemoryWrite?: (payload: PluginSharedMemoryWritePayload) => void
  onSharedMemoryDelete?: (payload: PluginSharedMemoryDeletePayload) => void
  onTeamDelegationStart?: (payload: PluginTeamDelegationStartPayload) => void
  onTeamDelegationComplete?: (payload: PluginTeamDelegationCompletePayload) => void
}

// =============================================================================
// Agent-Team hook payloads
// =============================================================================

/** Common context every team hook carries. */
export interface PluginTeamHookContext {
  teamId: string
  runId: string
}

export interface PluginTeamStartPayload extends PluginTeamHookContext {
  /** Lightweight roster snapshot — full teammate objects stay host-side. */
  workers: Array<{ id: string; name: string; role: "lead" | "teammate" }>
  taskCount: number
}

export interface PluginTeamPlanReadyPayload extends PluginTeamHookContext {
  /** The raw planning output the dispatcher will execute against. */
  plan: string
}

export interface PluginTeammateClaimPayload extends PluginTeamHookContext {
  teammateId: string
  taskId: string
}

export interface PluginTeammateReleasePayload extends PluginTeamHookContext {
  teammateId: string
  taskId: string
  result: "success" | "failure"
  error?: string
}

export interface PluginTeamBudgetWarnPayload extends PluginTeamHookContext {
  level: "warning" | "critical"
  used: number
  limit: number
}

export interface PluginTeamCompletePayload extends PluginTeamHookContext {
  status: "completed" | "failed" | "cancelled"
  reason?: string
}

export interface PluginConsensusOpenedPayload extends Omit<PluginTeamHookContext, "runId"> {
  consensusId: string
  question: string
  options: string[]
}

export interface PluginConsensusVotedPayload extends Omit<PluginTeamHookContext, "runId"> {
  consensusId: string
  voterId: string
  optionIndex: number
}

export interface PluginConsensusResolvedPayload extends Omit<PluginTeamHookContext, "runId"> {
  consensusId: string
  winningOption: number
  summary?: string
}

export interface PluginSharedMemoryWritePayload extends Omit<PluginTeamHookContext, "runId"> {
  key: string
  writerId: string
}

export interface PluginSharedMemoryDeletePayload extends Omit<PluginTeamHookContext, "runId"> {
  key: string
}

export interface PluginTeamDelegationStartPayload {
  delegationId: string
  sourceTeamId: string
  sourceTaskId: string
  targetType: "sub_agent" | "team" | "background" | "twin"
  targetId?: string
}

export interface PluginTeamDelegationCompletePayload {
  delegationId: string
  status: "completed" | "failed" | "cancelled" | "timeout"
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
  icon?: PluginIconName

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
export interface PluginBaseContext {
  /** Plugin ID */
  pluginId: string

  /** Plugin directory path */
  pluginPath: string

  /** Plugin configuration */
  config: Record<string, unknown>

  /** Abort-aware lifecycle for the current activation generation. */
  lifecycle?: PluginLifecycleAPI

  /** Read-only runtime service metadata; business calls still use governed domain APIs. */
  services?: PluginServicesAPI

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

  /**
   * System Tray API — register / unregister tray menu items. Available
   * only when the plugin declares the `"tray"` capability in its manifest;
   * otherwise the API is a no-op (every method returns a disposed handle).
   */
  tray: PluginTrayAPI

  /**
   * Quick Actions API — register actions surfaced in the command palette,
   * composer quick-actions menu, and tray. Available only when the plugin
   * declares the `"quick-action"` capability; otherwise a warn-once no-op.
   */
  quickActions: PluginQuickActionsAPI

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

  /**
   * Dexie table API — only present when the plugin manifest declares a
   * `dexie` block. Plugins access their IndexedDB tables through this API;
   * the namespace prefix is applied automatically.
   */
  dexie?: PluginDexieAPI

  // ---------------------------------------------------------------------------
  // ADR-0026 v2 namespaces. Optional on the base context — the host's
  // `createFullPluginContext` always wires them up, but `createPluginContext`
  // (the bare-bones variant used in some test paths) may omit them. Plugin
  // authors should null-check or rely on TypeScript's narrowing.
  // ---------------------------------------------------------------------------

  /** OCR provider registration (ADR-0026 §2 §A). */
  ocr?: import("@/lib/plugin/api/ocr-api").PluginOcrAPI

  /** Workspace backend registration (ADR-0026 §2 §D). */
  workspace?: import("@/lib/plugin/api/workspace-api").PluginWorkspaceAPI

  /** Modal stack push/close (ADR-0026 §3 §A). */
  modal?: import("@/lib/plugin/api/modal-api").PluginModalAPI

  /** Sandboxed webview create + messaging (B3). */
  webview?: import("@/lib/plugin/api/webview-api").PluginWebviewAPI

  /** Native auth/OAuth provider register + session consume (C1). */
  auth?: import("@/lib/plugin/api/auth-api").PluginAuthAPI

  /** URI / deep-link handler registration (C2). */
  uri?: import("@/lib/plugin/api/uri-api").PluginUriAPI

  /** Chat-middleware registration (ADR-0026 §4 §A). */
  chat?: import("@/lib/plugin/api/chat-api").PluginChatAPI

  /** Platform-capability flags (ADR-0026 §5 §C). */
  capabilities?: import("@/lib/plugin/api/capabilities-api").PluginCapabilitiesAPI

  /** Resource-scoped Context Workbench panel registration. */
  contextPanels?: import("@/lib/plugin/api/context-panel-api").PluginContextPanelAPI

  /**
   * Live project editor — open files, reflect edits, read what the user is
   * looking at. Engine-agnostic: the built-in Monaco workbench and the embedded
   * code-server "Pro IDE" both answer.
   */
  editor?: import("@/lib/plugin/api/editor-api").PluginEditorAPI

  /** Desktop pet — available only with the "pet" capability; warn-once no-op otherwise. */
  pet?: import("@/lib/plugin/api/pet-api").PluginPetAPI
}

/** Generation-scoped cancellation and teardown registration. */
export interface PluginLifecycleAPI {
  /** Aborted before activation-owned resources begin teardown. */
  readonly signal: AbortSignal

  /** Register activation-owned cleanup in the generation's LIFO ledger. */
  onDispose(dispose: () => void | Promise<void>, label?: string): void
}

export interface PluginLifecycleScopeToken {
  realmId: string
  pluginId: string
  generation: number
  scopeId: string
}

export interface PluginChildLifecycleAPI extends PluginLifecycleAPI {
  /** Explicit ownership token for APIs that accept caller-selected scopes. */
  readonly token: PluginLifecycleScopeToken
}

export interface PluginServiceProviderMetadata {
  pluginId: string
  version: string
  generation: number
}

export interface PluginOptionalServiceChange {
  serviceId: string
  provider: PluginServiceProviderMetadata | undefined
  lifecycle: PluginChildLifecycleAPI
}

export type PluginOptionalServiceListener = (
  change: PluginOptionalServiceChange
) => void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>

export interface PluginServicesAPI {
  isAvailable(serviceId: string): boolean
  getProvider(serviceId: string): PluginServiceProviderMetadata | undefined
  /**
   * Stage-3 scoped optional feature lifecycle. The listener runs once
   * immediately and again with a fresh child scope whenever the selected
   * optional provider changes.
   */
  onOptionalServiceChange(serviceId: string, listener: PluginOptionalServiceListener): () => void
}

/** Host-mounted namespaces present on every activated plugin context. */
export interface PluginHostContextAPI {
  lifecycle: PluginLifecycleAPI
  services: PluginServicesAPI
  ocr: import("@/lib/plugin/api/ocr-api").PluginOcrAPI
  workspace: import("@/lib/plugin/api/workspace-api").PluginWorkspaceAPI
  modal: import("@/lib/plugin/api/modal-api").PluginModalAPI
  webview: import("@/lib/plugin/api/webview-api").PluginWebviewAPI
  auth: import("@/lib/plugin/api/auth-api").PluginAuthAPI
  uri: import("@/lib/plugin/api/uri-api").PluginUriAPI
  chat: import("@/lib/plugin/api/chat-api").PluginChatAPI
  capabilities: import("@/lib/plugin/api/capabilities-api").PluginCapabilitiesAPI
  git: import("@/lib/plugin/api/git-api").PluginGitAPI
  goals: import("@/lib/plugin/api/goal-api").PluginGoalAPI
  /** ADR-0045 plan hub — read/author/approve/run `AgentPlan`s. */
  plans: import("@/lib/plugin/api/plan-api").PluginPlanAPI
  memory: import("@/lib/plugin/api/memory-api").PluginMemoryAPI
  team: import("@/lib/plugin/api/team-api").PluginTeamAPI
  subscription: import("@/lib/plugin/api/subscription-api").PluginSubscriptionAPI
  terminal: import("@/lib/plugin/api/terminal-api").PluginTerminalAPI
  perf: import("@/lib/plugin/api/perf-api").PluginPerfAPI
  /** Read-only logs + agent-trace access (`logs:read` / `trace:read`). */
  logs: import("@/lib/plugin/api/logs-api").PluginLogsAPI
  connectors: import("@/lib/plugin/api/connectors-api").PluginConnectorsAPI
  integrations: PluginIntegrationsAPI
  share: import("@/lib/plugin/api/share-api").PluginShareAPI
  backup: import("@/lib/plugin/api/backup-api").PluginBackupAPI
  automation: import("@/lib/plugin/api/automation-api").PluginAutomationAPI
  companion: import("@/lib/plugin/api/companion-api").PluginCompanionAPI
  pet: import("@/lib/plugin/api/pet-api").PluginPetAPI
}

/**
 * Complete public context passed to `activate` and `deactivate`.
 *
 * `PluginBaseContext` exists only for the host's construction pipeline;
 * plugin authors always receive this fully mounted contract.
 */
export type PluginContext = Omit<
  PluginBaseContext,
  keyof PluginContextAPI | keyof PluginHostContextAPI
> &
  PluginContextAPI &
  PluginHostContextAPI

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
   * orchestrator's standard trigger queue. Pass `triggerId` when a workflow
   * can contain multiple enabled nodes of this kind; legacy calls are
   * inferred only when exactly one matching root exists.
   */
  emitTriggerEvent(workflowId: string, kind: string, payload: unknown, triggerId?: string): void
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
  /**
   * Inter-plugin IPC — directed / broadcast / RPC messaging between plugins.
   * Present on the full runtime context (`createFullPluginContext`); optional
   * here because the minimal base context does not attach it. `call`/`expose`
   * are gated by the `ipc:call` / `ipc:expose` permissions.
   */
  ipc?: PluginIPCAPI
  /**
   * Global cross-plugin pub/sub event bus (system lifecycle events live under
   * the `system:*` namespace). Present on the full runtime context.
   */
  bus?: PluginEventAPI
}

export interface PluginUIAPI {
  showNotification: (options: PluginNotification) => void
  showToast: (message: string, type?: "info" | "success" | "warning" | "error") => void
  showDialog: (options: PluginDialog) => Promise<unknown>
  showInputDialog: (options: PluginInputDialog) => Promise<string | null>
  showConfirmDialog: (options: PluginConfirmDialog) => Promise<boolean>
}

export interface PluginNotification {
  title: string
  body?: string
  message?: string
  type?: "info" | "success" | "warning" | "error"
  icon?: PluginIconName
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
  registerTool: (tool: PluginTool) => () => void
  unregisterTool: (name: string) => void
  registerMode: (mode: AgentModeConfig) => () => void
  unregisterMode: (id: string) => void
  /**
   * Run one agent turn and resolve with the typed result. The embeddable
   * counterpart to the chat agent: text-only by default, tool-enabled (sidecar
   * loop) when `toolsEnabled` is set (requires the `agent:control` permission).
   * Supports structured output (`outputFormat`) and a rewrite-capable
   * `canUseTool` permission gate. See ADR-0026 §Agent-SDK.
   */
  run: (prompt: string, options?: PluginAgentRunOptions) => Promise<PluginAgentRunResult>
  /**
   * Run one agent turn as a live async-iterable of typed events (`text-delta`
   * / `tool-call` / `tool-result` / `result`). The handle also exposes a
   * `result` promise and `cancel()`.
   */
  runStreamed: (prompt: string, options?: PluginAgentRunOptions) => PluginAgentRun
  /**
   * Invoke a host/plugin tool by name and resolve with its result — lets a
   * plugin reuse the host's tool surface (including its own registered tools)
   * from inside its code. Routes through the unified `invokePluginTool` seam
   * (ownership + permission gate + lazy activation). Requires `agent:control`.
   */
  invokeTool: (
    name: string,
    args: Record<string, unknown>,
    opts?: { signal?: AbortSignal }
  ) => Promise<unknown>
  /** Invoke a tool owned by a required dependency declared in the manifest. */
  invokeDependencyTool: (
    dependencyId: string,
    name: string,
    args: Record<string, unknown>,
    opts?: { signal?: AbortSignal; sessionId?: string; messageId?: string }
  ) => Promise<unknown>
  /**
   * @deprecated Use {@link run} / {@link runStreamed}. Retained as a thin shim
   * mapping the legacy untyped config bag onto `run()`.
   */
  executeAgent: (config: Record<string, unknown>) => Promise<unknown>
  cancelAgent: (agentId: string) => void
  /**
   * Imperatively run an external coding agent (Claude Code / Codex / Gemini
   * CLI / Cursor / …) and resolve with its result. `presetOrAgentId` is either
   * a live external-agent instance id or a preset id — including presets a
   * plugin contributed via `registerExternalAgentPreset`. Requires the
   * `agent:dispatch-external` manifest permission. Desktop-only (external
   * agents are spawned through the Tauri process bridge).
   */
  runExternalAgent: (
    presetOrAgentId: string,
    prompt: string,
    options?: Record<string, unknown>
  ) => Promise<unknown>
  /**
   * Plugin-first Computer Use plan (M1·T5). The four register*Preset / *Tool
   * / *Skill methods below are the imperative-style entry points that mirror
   * `registerTool`. They write into the matching §A-3 overlay registry under
   * `lib/plugin/registries/`. The plugin manager also wires the declarative
   * manifest-driven path: anything listed in `manifest.mcpServerPresets` /
   * `manifest.nativeAnthropicTools` / `manifest.skills` /
   * `manifest.externalAgentPresets` is registered on plugin enable, and
   * unregistered in bulk via `unregister*ByPlugin(pluginId)` on disable —
   * so plugins typically use the declarative form and only reach for these
   * imperative methods when they need dynamic ids resolved at activate-time.
   */
  registerMcpServerPreset: (def: PluginMcpServerPresetDef) => void
  registerNativeAnthropicTool: (def: PluginNativeAnthropicToolDef) => void
  registerSkill: (def: PluginSkillDef) => void
  registerExternalAgentPreset: (def: PluginExternalAgentPresetDef) => void
  /**
   * Imperative twin of the declarative `manifest.externalAgentAdapters` field.
   * Registers a `() => ProtocolAdapter` factory into the external-agent
   * `protocolAdapterRegistry` under the namespaced protocol `${pluginId}:${id}`
   * (collision-safe), so a plugin can contribute a brand-new external-agent
   * protocol at activate-time. Unregistered in bulk on plugin disable.
   */
  registerExternalAgentAdapter: (id: string, factory: ProtocolAdapterFactory) => void
  /**
   * Input/output guardrails (Package B). Register reusable guardrails that a
   * run opts into by id via `PluginAgentRunOptions.guardrails`. A tripped
   * guardrail aborts the run with a `PluginGuardrailTripwireError`.
   */
  guardrails: PluginAgentGuardrailsAPI
  /**
   * Dispatch a built-in/plugin subagent on a prompt (Package C). Resolves a
   * registered subagent by id or accepts an inline definition; maps it onto a
   * one-shot tool-enabled run. Requires the `agent:dispatch` permission.
   */
  dispatchSubagent: (
    idOrDef: string | PluginSubagentDef,
    prompt: string,
    options?: PluginDispatchSubagentOptions
  ) => Promise<PluginSubagentDispatchResult>
  /**
   * Run an Agent Team headlessly (Package C) by existing team id or ad-hoc team
   * config. Reuses the host team runtime (inflight guard + configured deps).
   * Requires the `agent:dispatch` permission.
   */
  runTeam: (
    teamOrConfig: string | AgentTeam,
    options?: PluginRunTeamOptions
  ) => Promise<PluginRunTeamResult>
  /**
   * Durable multi-turn sessions (Package D). Create or resume a session a
   * plugin owns; each `send` resumes the prior conversation. Requires the
   * `session:write` (create) / `session:read` (resume) permissions.
   */
  sessions: PluginAgentSessionsAPI
  /**
   * Context/memory providers + guarded reads (Package E). Register providers
   * that inject ambient context into the plugin's runs; read team
   * shared-memory (agent:shared-memory:read) and twin memory (twin:read).
   */
  context: PluginAgentContextAPI
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

export type PluginNetworkHttpMethod =
  "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS"

export interface PluginNetworkAccessRule {
  /** Host suffix (`example.com` includes `api.example.com`) or `*`. */
  domain: string
  /** HTTP methods admitted by this rule. */
  methods: PluginNetworkHttpMethod[]
  /** URL pathname globs admitted by this rule. */
  paths: string[]
}

export type NetworkDataClassification =
  "public" | "operational" | "internal" | "confidential" | "restricted"

export interface NetworkEgressPolicyOptions {
  /** Data class recorded for policy/audit consumers. */
  dataClassification?: NetworkDataClassification
  /** Redact recognized PII/secrets (default) or block the request. */
  piiPolicy?: "redact" | "block"
}

export interface NetworkRequestOptions extends NetworkEgressPolicyOptions {
  method?: PluginNetworkHttpMethod
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

export interface DownloadOptions extends NetworkEgressPolicyOptions {
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

export interface UploadOptions extends NetworkEgressPolicyOptions {
  headers?: Record<string, string>
  fieldName?: string
  /**
   * Policy for the file bytes themselves. Defaults to `block` because the
   * host cannot safely redact arbitrary binary formats. `allow` requires an
   * explicit `dataClassification` and is enforced again by the native host.
   */
  fileContentPolicy?: "block" | "allow"
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
  /**
   * Arguments passed to the program literally — never interpreted by a shell.
   * The `command` is the program name (the declared allowlist key); put each
   * argument here so a declared command can't smuggle extra commands through a
   * single string.
   */
  args?: string[]
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
 * Declarative tray contribution stored in `manifest.trayItems[]`.
 */
export interface PluginManifestTrayItemDef {
  /** Local id — the host prefixes it with the plugin id. */
  id: string
  label: string
  /** Plugin i18n key preferred over `label` for the active locale. */
  labelKey?: string
  icon?: PluginIconName
  when?: string
  category?: string
  accelerator?: string
  command?: string
  slash?: string
}

/**
 * Tray menu item contributed by a plugin. Mirrors `ContextMenuItem` but
 * targets the system-tray surface rather than the right-click context menu.
 */
export interface PluginTrayItemInput extends Omit<PluginManifestTrayItemDef, "command" | "slash"> {
  /** Local id — the host prefixes it with the plugin id before recording. */
  id: string
  /** Click handler — invoked by the renderer when the tray dispatches. */
  onClick: () => void
}

/**
 * System tray API surfaced via `ctx.tray`. Mirrors the context-menu shape
 * (`PluginContextMenuAPI`) so plugin authors learn one pattern.
 */
export interface PluginTrayAPI {
  /** Register one tray item. Returns a disposer that unregisters it. */
  register: (item: PluginTrayItemInput) => () => void
  /** Convenience for multiple items; the returned disposer drops all of them. */
  registerMany: (items: PluginTrayItemInput[]) => () => void
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
  icon?: PluginIconName
  /** Which zone(s) this item targets. `undefined` = every zone. */
  when?: ContextMenuContext | ContextMenuContext[]
  /**
   * Declarative state condition evaluated against the context-key store
   * (`lib/plugin/context-keys`) — e.g. `"chat.active && !chat.streaming"`.
   * Distinct from `when` (which selects zones): the item is shown only while
   * `whenExpr` holds. Absent = no state gate. Fail-closed on a malformed
   * expression.
   */
  whenExpr?: string
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
  // Geometry getters are async: they query the real host window rather than
  // returning the hardcoded placeholders the SDK used to fabricate.
  isMaximized: () => Promise<boolean>
  setSize: (width: number, height: number) => void
  getSize: () => Promise<{ width: number; height: number }>
  setPosition: (x: number, y: number) => void
  getPosition: () => Promise<{ x: number; y: number }>
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
  /** Key names this plugin has stored (for migration / cleanup UIs). */
  keys: () => Promise<string[]>
  /** VS Code parity — fires after store/delete on this plugin's namespace. */
  onDidChange: (listener: (e: { key: string }) => void) => () => void
}

/** Where a plugin's secrets are stored at rest, so a plugin can detect strength. */
export type PluginSecretsBackend = "os-keyring" | "encrypted-web" | "memory"

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
 * Host-level per-plugin runtime settings (user state persisted on the
 * Dexie plugins row — NOT a manifest field). Wire-exact counterpart of
 * `PythonHostSettings` in `src-tauri/src/plugin_api/python/commands.rs`.
 *
 * There is deliberately no `lazySpawn` knob: the first load is always
 * eager (dependency validation + tool/hook collection); the perf win
 * comes from `idleShutdownMin` demotion + transparent respawn.
 */
export interface PythonHostSettings {
  /** Absolute interpreter override for this plugin (beats venv + global). */
  interpreterPath?: string
  /** Extra environment variables for the host process. */
  env?: Record<string, string>
  /** Per-plugin override of the default 120s call timeout (clamped 1s–1h). */
  callTimeoutMs?: number
  /** `false` opts out of an existing venv (default: use it when present). */
  useVenv?: boolean
  /** Idle minutes before the host is demoted to a lazy slot; 0 = never. */
  idleShutdownMin?: number
  /** In-flight request cap per host (default 4). */
  maxConcurrentCalls?: number
  /**
   * ADR-0028 Phase 3 — run the interpreter under the OS sandbox
   * (`bwrap` / `sandbox-exec`) on Linux/macOS. Off by default; defaults from
   * the global sandbox toggle at load. Windows is not wrapped yet (its
   * restricted-token runner can't host a long-lived stdio JSON-RPC process).
   */
  sandboxed?: boolean
}

/** One `@hook` declared by a python plugin, from `import_main`'s reply. */
export interface PythonHookDeclaration {
  event: string
  name: string
}

/** Reply of `plugin_python_load` (the host's `import_main` info). */
export interface PythonLoadResult {
  tool_count: number
  hook_count: number
  generation: string
  hooks?: PythonHookDeclaration[]
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

// =============================================================================
// Plugin Dexie tables (manifest.dexie)
// =============================================================================

/**
 * Plugin-declared Dexie tables. Tables are namespaced as
 * `<pluginId>:<tableName>` in the underlying CogniaDB instance.
 *
 * Plugins access their tables via `ctx.dexie.table<T>(name)` — the
 * pluginId prefix is stripped from the public name.
 */
export interface PluginManifestDexieBlock {
  /** Table declarations. Maximum 20 per plugin. */
  tables: PluginDexieTableDef[]
  /** Optional migration callbacks invoked once per (pluginId, toVersion). */
  migrations?: PluginDexieMigrationDef[]
}

export interface PluginDexieTableDef {
  /**
   * Logical table name without the pluginId prefix.
   * Must match `^[a-z][a-zA-Z0-9_]{0,30}$` — runtime-enforced in
   * `lib/plugin/core/validation.ts`.
   */
  name: string
  /**
   * Dexie schema string (same syntax as `db.version().stores({})` values).
   * Examples: "++id, name", "deliveryId, [target+at]", "&pluginId, updatedAt".
   */
  schema: string
}

export interface PluginDexieMigrationDef {
  /**
   * The manifest plugin-version (parsed from manifest.version major) this
   * migration upgrades to. Runs when the plugin's recorded manifest version
   * is < toVersion.
   */
  toVersion: number
  /**
   * Name of an exported function on the plugin module. Receives no args
   * (the plugin can use `ctx.dexie` to operate on its tables). Errors put
   * the plugin into an "error" state and the migration is retried on next
   * enable, so make migrations idempotent.
   */
  upgrade: string
}

/**
 * Runtime API for accessing a plugin's declared Dexie tables.
 * Obtained via `ctx.dexie` — only present when the plugin manifest
 * includes a `dexie` block.
 */
export interface PluginDexieAPI {
  /**
   * Returns a Dexie Table for the given logical name (as declared in
   * manifest.dexie.tables, WITHOUT the `<pluginId>:` prefix).
   * Throws if the table is not in this plugin's namespace.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table<T = unknown, K = any>(name: string): import("dexie").Table<T, K>

  /**
   * Returns the raw Dexie instance for advanced queries / transactions.
   * The plugin is responsible for only reading/writing its own tables.
   */
  rawDb(): import("dexie").Dexie
}

// =============================================================================
// Extended Plugin APIs (session / project / vector / theme / export / import /
// canvas / artifact / notifications / storage / AI provider / extensions /
// permissions) — the feature-specific API surface consumed by ctx.*
// =============================================================================

// =============================================================================
// Session API - Chat Session Management
// =============================================================================

/**
 * Filter options for listing sessions
 */
export interface SessionFilter {
  projectId?: string
  mode?: ChatMode
  hasMessages?: boolean
  createdAfter?: Date
  createdBefore?: Date
  limit?: number
  offset?: number
  sortBy?: "createdAt" | "updatedAt" | "title"
  sortOrder?: "asc" | "desc"
}

/**
 * Options for querying messages
 */
export interface MessageQueryOptions {
  limit?: number
  offset?: number
  branchId?: string
  includeDeleted?: boolean
  afterId?: string
  beforeId?: string
}

/**
 * Options for sending messages
 */
export interface SendMessageOptions {
  role?: "user" | "assistant" | "system"
  attachments?: MessageAttachment[]
  metadata?: Record<string, unknown>
  skipProcessing?: boolean
}

/**
 * Message attachment for plugin use
 */
export interface MessageAttachment {
  type: "file" | "image" | "code" | "url"
  name: string
  content?: string
  url?: string
  mimeType?: string
  size?: number
}

/**
 * Session API for plugins
 */
export interface PluginSessionAPI {
  /** Get the currently active session */
  getCurrentSession: () => Session | null

  /** Get the current session ID */
  getCurrentSessionId: () => string | null

  /** Get a session by ID */
  getSession: (id: string) => Promise<Session | null>

  /** Create a new session */
  createSession: (options?: CreateSessionInput) => Promise<Session>

  /** Update a session */
  updateSession: (id: string, updates: UpdateSessionInput) => Promise<void>

  /** Switch to a different session */
  switchSession: (id: string) => Promise<void>

  /** Delete a session */
  deleteSession: (id: string) => Promise<void>

  /** List sessions with optional filtering */
  listSessions: (filter?: SessionFilter) => Promise<Session[]>

  /** Get messages for a session */
  getMessages: (sessionId: string, options?: MessageQueryOptions) => Promise<UIMessage[]>

  /** Add a message to a session */
  addMessage: (
    sessionId: string,
    content: string,
    options?: SendMessageOptions
  ) => Promise<UIMessage>

  /** Update a message */
  updateMessage: (
    sessionId: string,
    messageId: string,
    updates: Partial<UIMessage>
  ) => Promise<void>

  /** Delete a message */
  deleteMessage: (sessionId: string, messageId: string) => Promise<void>

  /** Subscribe to session changes */
  onSessionChange: (handler: (session: Session | null) => void) => () => void

  /** Subscribe to message changes in a session */
  onMessagesChange: (sessionId: string, handler: (messages: UIMessage[]) => void) => () => void

  /** Get session statistics */
  getSessionStats: (sessionId: string) => Promise<SessionStats>
}

/**
 * Session statistics
 */
export interface SessionStats {
  messageCount: number
  userMessageCount: number
  assistantMessageCount: number
  totalTokens: number
  averageResponseTime: number
  branchCount: number
  attachmentCount: number
}

// =============================================================================
// Project API - Project Management
// =============================================================================

/**
 * Filter options for listing projects
 */
export interface ProjectFilter {
  isArchived?: boolean
  tags?: string[]
  createdAfter?: Date
  createdBefore?: Date
  limit?: number
  offset?: number
  sortBy?: "createdAt" | "updatedAt" | "lastAccessedAt" | "name"
  sortOrder?: "asc" | "desc"
}

/**
 * Project file input for adding to knowledge base
 */
export interface ProjectFileInput {
  name: string
  content: string
  type?: KnowledgeFile["type"]
  mimeType?: string
}

/**
 * Project API for plugins
 */
export interface PluginProjectAPI {
  /** Get the currently active project */
  getCurrentProject: () => Project | null

  /** Get the current project ID */
  getCurrentProjectId: () => string | null

  /** Get a project by ID */
  getProject: (id: string) => Promise<Project | null>

  /** Create a new project */
  createProject: (options: CreateProjectInput) => Promise<Project>

  /** Update a project */
  updateProject: (id: string, updates: UpdateProjectInput) => Promise<void>

  /** Delete a project */
  deleteProject: (id: string) => Promise<void>

  /** Set the active project */
  setActiveProject: (id: string | null) => Promise<void>

  /** List projects with optional filtering */
  listProjects: (filter?: ProjectFilter) => Promise<Project[]>

  /** Archive a project */
  archiveProject: (id: string) => Promise<void>

  /** Unarchive a project */
  unarchiveProject: (id: string) => Promise<void>

  /** Add a file to project knowledge base */
  addKnowledgeFile: (projectId: string, file: ProjectFileInput) => Promise<KnowledgeFile>

  /** Remove a file from project knowledge base */
  removeKnowledgeFile: (projectId: string, fileId: string) => Promise<void>

  /** Update a knowledge file */
  updateKnowledgeFile: (projectId: string, fileId: string, content: string) => Promise<void>

  /** Get all knowledge files for a project */
  getKnowledgeFiles: (projectId: string) => Promise<KnowledgeFile[]>

  /** Link a session to a project */
  linkSession: (projectId: string, sessionId: string) => Promise<void>

  /** Unlink a session from a project */
  unlinkSession: (projectId: string, sessionId: string) => Promise<void>

  /** Get all sessions for a project */
  getProjectSessions: (projectId: string) => Promise<string[]>

  /** Subscribe to project changes */
  onProjectChange: (handler: (project: Project | null) => void) => () => void

  /** Add a tag to a project */
  addTag: (projectId: string, tag: string) => Promise<void>

  /** Remove a tag from a project */
  removeTag: (projectId: string, tag: string) => Promise<void>
}

// =============================================================================
// Vector/RAG API - Semantic Search and Retrieval
// =============================================================================

/**
 * Vector document for storage
 */
export interface VectorDocument {
  id?: string
  content: string
  metadata?: Record<string, unknown>
  embedding?: number[]
}

/**
 * Vector search options
 */
export interface VectorSearchOptions {
  topK?: number
  threshold?: number
  filters?: VectorFilter[]
  filterMode?: "and" | "or"
  includeMetadata?: boolean
  includeEmbeddings?: boolean
}

/**
 * Vector filter for search
 */
export interface VectorFilter {
  key: string
  value: string | number | boolean
  operation: "eq" | "ne" | "gt" | "lt" | "gte" | "lte" | "contains" | "in"
}

/**
 * Vector search result
 */
export interface VectorSearchResult {
  id: string
  content: string
  metadata?: Record<string, unknown>
  score: number
  embedding?: number[]
}

/**
 * Collection options for vector store
 */
export interface CollectionOptions {
  embeddingModel?: string
  dimensions?: number
  metadata?: Record<string, unknown>
}

/**
 * Collection statistics
 */
export interface CollectionStats {
  name: string
  documentCount: number
  dimensions: number
  createdAt: Date
  lastUpdated: Date
  sizeBytes?: number
}

/**
 * Vector/RAG API for plugins
 */
export interface PluginVectorAPI {
  /** Create a new collection */
  createCollection: (name: string, options?: CollectionOptions) => Promise<string>

  /** Delete a collection */
  deleteCollection: (name: string) => Promise<void>

  /** List all collections */
  listCollections: () => Promise<string[]>

  /** Get collection info */
  getCollectionInfo: (name: string) => Promise<CollectionStats>

  /** Add documents to a collection */
  addDocuments: (collection: string, docs: VectorDocument[]) => Promise<string[]>

  /** Update documents in a collection */
  updateDocuments: (collection: string, docs: VectorDocument[]) => Promise<void>

  /** Delete documents from a collection */
  deleteDocuments: (collection: string, ids: string[]) => Promise<void>

  /** Search documents in a collection */
  search: (
    collection: string,
    query: string,
    options?: VectorSearchOptions
  ) => Promise<VectorSearchResult[]>

  /** Search with a pre-computed embedding */
  searchByEmbedding: (
    collection: string,
    embedding: number[],
    options?: VectorSearchOptions
  ) => Promise<VectorSearchResult[]>

  /** Generate embedding for text */
  embed: (text: string) => Promise<number[]>

  /** Generate embeddings for multiple texts */
  embedBatch: (texts: string[]) => Promise<number[][]>

  /** Get document count in a collection */
  getDocumentCount: (collection: string) => Promise<number>

  /** Clear all documents in a collection */
  clearCollection: (collection: string) => Promise<void>
}

// =============================================================================
// Theme API - Appearance Customization
// =============================================================================

/**
 * Theme mode
 */
export type ThemeMode = "light" | "dark" | "system"

/**
 * Color theme preset
 */
export type ColorThemePreset =
  "default" | "ocean" | "forest" | "sunset" | "lavender" | "rose" | "slate" | "amber"

/**
 * Theme colors structure
 */
export interface ThemeColors {
  primary: string
  primaryForeground: string
  secondary: string
  secondaryForeground: string
  accent: string
  accentForeground: string
  background: string
  foreground: string
  muted: string
  mutedForeground: string
  card: string
  cardForeground: string
  popover: string
  popoverForeground: string
  input: string
  border: string
  ring: string
  destructive: string
  destructiveForeground: string
  sidebar: string
  sidebarForeground: string
  sidebarPrimary: string
  sidebarBorder: string
  sidebarPrimaryForeground: string
  sidebarAccent: string
  sidebarAccentForeground: string
  sidebarRing: string
}

/**
 * Custom theme definition.
 *
 * Phase 2 of the theme/background fix introduced a dual-variant shape:
 * a saved theme now carries both `tokens.light` and `tokens.dark` so the
 * runtime can render the right palette regardless of which side the
 * `next-themes` resolver lands on. The legacy `colors`/`isDark` fields
 * are retained one release for migration safety — Task 8 ships the
 * Dexie v16 migration that fills `tokens` for older rows.
 */
export interface CustomTheme {
  id: string
  name: string

  // ----- New dual-variant fields (Phase 2) -----
  /** User's original variant intent — drives default light/dark when activated. */
  baseVariant?: "light" | "dark"
  /** Both variant palettes. The `derivedVariant` was filled by the algorithm. */
  tokens?: { light: ThemeColors; dark: ThemeColors }
  /**
   * Marks which side was auto-derived (vs hand-edited or imported).
   * Set by the v16 migration (Task 8) when promoting legacy rows, and by the
   * VSCode import path (Task 9) when one variant is filled by deriveOppositeVariant.
   */
  derivedVariant?: "light" | "dark"

  // ----- Legacy single-set fields (kept one release for migration safety) -----
  /** @deprecated Read via `tokens` instead. Retained for pre-v16 rows. */
  colors?: Partial<ThemeColors>
  /** @deprecated Read via `baseVariant` instead. Retained for pre-v16 rows. */
  isDark?: boolean

  /**
   * Plugin id this theme was seeded from when the user activated a plugin
   * preset. Metadata only — the row lives in `customThemes` independently
   * of plugin enable/disable, matching the user's "what I'm using is mine"
   * intuition. Useful for badging "originated from <plugin>".
   */
  sourcePluginId?: string
  /**
   * Built-in VSCode preset name this theme was cloned from (e.g., "Dracula").
   * Set when the user activates a built-in preset card so subsequent clicks
   * on the same card reuse this row instead of spawning N clones. Mutually
   * exclusive with `sourcePluginId`.
   */
  sourceBuiltinName?: string

  /**
   * Extra CSS custom properties beyond the 27 standard `ThemeColors` tokens,
   * carried verbatim from a plugin's `cssVariables` theme contribution
   * (ADR-0026 §3 §D). Applied inline after the structured token pass by
   * `CustomThemeApplier` so a cloned CSS-var plugin theme keeps ALL of its
   * variables — not just the two the structured swatch path captures. Each
   * key is a full custom-property name (`--foo`); values are pre-sanitized by
   * the themes-bridge. Undefined for hand-built / VSCode-imported themes.
   */
  cssVars?: Record<string, string>

  /**
   * Plugin id that created this row through the imperative `ctx.theme` API.
   * Persisted (unlike the in-memory ownership map) so
   * `clearCustomThemesForPluginContext` can garbage-collect orphan rows after
   * a restart. Distinct from `sourcePluginId`, which merely records where a
   * user-activated preset originated; `ownerPluginId` means the plugin owns
   * the row's lifecycle and it is removed when the plugin is disabled.
   */
  ownerPluginId?: string
}

/**
 * Current theme state
 */
/**
 * Motion preferences, in the form a plugin's *JavaScript* can act on.
 *
 * CSS-driven animation already follows the user automatically: plugin UI
 * inherits `--motion-duration-scale` and the `reduce-motion` reset through the
 * cascade. Anything driven from JS — `Element.animate`, `requestAnimationFrame`,
 * a bundled animation library — cannot see either, so without this a plugin
 * keeps animating after the user has explicitly asked it not to.
 */
export interface ThemeMotionState {
  /** Multiplier to apply to your own durations. Mirrors `--motion-duration-scale`. */
  durationScale: number
  /**
   * True when animation should be suppressed. Covers BOTH the in-app setting
   * and the OS-level `prefers-reduced-motion`, which the app otherwise handles
   * only in CSS — so this is the single check a plugin needs.
   */
  reduced: boolean
}

/** Spacing scale currently applied, mirroring the `--density-*` variables. */
export interface ThemeDensityState {
  level: "compact" | "comfortable" | "spacious"
  spacing: string
  gap: string
  rowPadding: string
  inputHeight: string
  lineHeight: string
}

/** Type scale currently applied, mirroring the typography variables. */
export interface ThemeTypographyState {
  lineHeightScale: number
  letterSpacingEm: number
}

export interface ThemeState {
  mode: ThemeMode
  resolvedMode: "light" | "dark"
  colorPreset: ColorThemePreset
  customThemeId: string | null
  /** Id of the directly-activated plugin theme (registry id), or null. */
  activePluginThemeId?: string | null
  themeSource?: "preset" | "custom" | "plugin"
  colors: ThemeColors
  /** Motion preferences — check `motion.reduced` before animating from JS. */
  motion: ThemeMotionState
  /** Applied spacing scale. Prefer the CSS variables where you can use them. */
  density: ThemeDensityState
  /** Applied type scale. */
  typography: ThemeTypographyState
  /** Corner radius in rem, mirroring `--radius`. */
  radius: number
}

/**
 * Theme API for plugins
 */
export interface PluginThemeAPI {
  /** Get current theme state */
  getTheme: () => ThemeState

  /** Get current theme mode */
  getMode: () => ThemeMode

  /** Get resolved theme mode (light or dark) */
  getResolvedMode: () => "light" | "dark"

  /** Set theme mode */
  setMode: (mode: ThemeMode) => void

  /** Get current color preset */
  getColorPreset: () => ColorThemePreset

  /** Set color preset */
  setColorPreset: (preset: ColorThemePreset) => void

  /** Get all color presets */
  getAvailablePresets: () => ColorThemePreset[]

  /** Get current theme colors */
  getColors: () => ThemeColors

  /** Register a custom theme */
  registerCustomTheme: (theme: Omit<CustomTheme, "id">) => string

  /** Update a custom theme */
  updateCustomTheme: (id: string, updates: Partial<CustomTheme>) => void

  /** Delete a custom theme */
  deleteCustomTheme: (id: string) => void

  /** Get all custom themes */
  getCustomThemes: () => CustomTheme[]

  /** Activate a custom theme */
  activateCustomTheme: (id: string) => void

  /**
   * Activate a theme registered in the in-memory plugin theme registry
   * (`manifest.themes`) directly, without cloning it into `customThemes`.
   * The theme applies live via a `<style data-plugin-theme>` block and is
   * cleared automatically when the owning plugin is disabled. Pass `null`
   * to deactivate and fall back to the preset / custom theme. The id is the
   * fully-qualified registry id (`<pluginId>.<contributionId>`).
   */
  activateRegisteredTheme: (themeId: string | null) => void

  /** Subscribe to theme changes */
  onThemeChange: (handler: (theme: ThemeState) => void) => () => void

  /** Apply CSS variables for a component (scoped styling) */
  applyScopedColors: (element: HTMLElement, colors: Partial<ThemeColors>) => () => void
}

// =============================================================================
// Export API - Data Export
// =============================================================================

/**
 * Export format types
 */
export type ExportFormat =
  "markdown" | "json" | "html" | "animated-html" | "pdf" | "text" | "docx" | "csv"

/**
 * Export options
 */
export interface ExportOptions {
  format: ExportFormat
  theme?: "light" | "dark" | "system"
  showTimestamps?: boolean
  showTokens?: boolean
  showThinkingProcess?: boolean
  showToolCalls?: boolean
  includeMetadata?: boolean
  includeAttachments?: boolean
  includeCoverPage?: boolean
  includeTableOfContents?: boolean
}

/**
 * Custom exporter definition
 */
export interface CustomExporter {
  id: string
  name: string
  description: string
  format: string
  extension: string
  mimeType: string
  export: (data: ExportData) => Promise<Blob | string>
}

/**
 * Export data payload
 */
export interface ExportData {
  session?: Session
  messages?: UIMessage[]
  project?: Project
  exportedAt: Date
  metadata?: Record<string, unknown>
}

/**
 * Export result
 */
export interface ExportResult {
  success: boolean
  blob?: Blob
  filename?: string
  error?: string
}

/**
 * Export API for plugins
 */
export interface PluginExportAPI {
  /** Export a session */
  exportSession: (sessionId: string, options: ExportOptions) => Promise<ExportResult>

  /** Export a project */
  exportProject: (projectId: string, options: ExportOptions) => Promise<ExportResult>

  /** Export messages */
  exportMessages: (messages: UIMessage[], options: ExportOptions) => Promise<ExportResult>

  /** Download an export result */
  download: (result: ExportResult, filename?: string) => void

  /** Register a custom exporter */
  registerExporter: (exporter: CustomExporter) => () => void

  /** Get available export formats */
  getAvailableFormats: () => ExportFormat[]

  /** Get custom exporters */
  getCustomExporters: () => CustomExporter[]

  /** Generate filename for export */
  generateFilename: (title: string, extension: string) => string
}

// =============================================================================
// Import API - content importers (symmetric counterpart of the Export API)
// =============================================================================

/**
 * Raw input handed to a {@link CustomImporter}. `content` is text for textual
 * formats or an `ArrayBuffer` for binary ones; `filename`/`mimeType` drive
 * extension/format matching when present.
 */
export interface ImportSource {
  content: string | ArrayBuffer
  filename?: string
  mimeType?: string
}

/**
 * Outcome of an import run. `data` is whatever the importer parsed (the plugin
 * decides the shape and what to do with it via other `ctx.*` APIs); `error` is
 * set on failure.
 */
export interface ImportResult<T = unknown> {
  success: boolean
  data?: T
  error?: string
}

/**
 * A content-import contribution — the symmetric counterpart of
 * {@link CustomExporter}. Register at activation via
 * `ctx.import.registerImporter(...)`; the host matches by `format` (and may
 * pre-filter candidates by `extensions`).
 */
export interface CustomImporter<T = unknown> {
  id: string
  name: string
  description: string
  /** Format key the host matches against (symmetric to `CustomExporter.format`). */
  format: string
  /** File extensions this importer handles (no leading dot, e.g. `["md","markdown"]`). */
  extensions: string[]
  mimeType?: string
  import: (source: ImportSource) => Promise<ImportResult<T>> | ImportResult<T>
}

/**
 * A chat-export importer contributed by a plugin (§A-4).
 *
 * Differs from the host's {@link ChatImporter} in two ways, both so the host
 * stays in control of the namespace:
 *   - `format` is the plugin's own bare id (`"slack"`); the host stores it as
 *     `${pluginId}:${format}` so a plugin can never claim or collide with a
 *     built-in format.
 *   - `label` is required, because a plugin format has no entry in the import
 *     dialog's label switch or in the message catalog.
 */
export interface PluginChatImporter<TData = unknown> extends Omit<
  ChatImporter<TData>,
  "format" | "label"
> {
  format: string
  label: string
}

/**
 * Import API for plugins. Mirrors {@link PluginExportAPI}: a per-plugin
 * registry of {@link CustomImporter}s plus a `importContent` runner that
 * dispatches to the importer registered for a format.
 */
export interface PluginImportAPI {
  /** Register a custom importer. Returns a disposer that unregisters it. */
  registerImporter: <T = unknown>(importer: CustomImporter<T>) => () => void

  /** All custom importers currently registered (across plugins). */
  getCustomImporters: () => CustomImporter[]

  /** Run the importer registered for `format` against `source`. */
  importContent: (source: ImportSource, format: string) => Promise<ImportResult>

  /**
   * Register an agent session-history source (ADR-0062). Lets a plugin add a
   * new importable coding-agent (e.g. an OpenCode variant, Cursor, Cline) so its
   * past on-disk sessions surface in the session-import dialog and convert to
   * continuable conversations. The adapter id is namespaced `${pluginId}:${id}`;
   * a plugin can never shadow a built-in source. Returns a disposer.
   */
  registerSessionSource: (adapter: AgentSessionSourceAdapter) => () => void

  /**
   * Register a chat-export importer (§A-4). Lets a plugin teach the app to
   * recognise and parse a conversation-export format the host doesn't ship
   * (Slack, Discord, Poe, …); once registered the format is sniffed by
   * `detectFormat` and offered in the chat-import dialog like a built-in.
   * The format id is namespaced `${pluginId}:${format}`. Returns a disposer.
   */
  registerChatImporter: <T = unknown>(importer: PluginChatImporter<T>) => () => void
}

// =============================================================================
// Configuration API - typed access to the plugin's own settings
// =============================================================================

/**
 * Runtime access to the plugin's declarative configuration (the values backing
 * `manifest.configSchema` / the settings form). Reads are seeded with schema
 * defaults so a key is non-`undefined` even before the user opens settings.
 * `update` validates against the schema, persists, and fans the change out to
 * the plugin's `onConfigChange` hook + `onChange` subscribers.
 */
export interface PluginConfigAPI {
  /** Read a config value (seeded with the schema default when unset). */
  get: <T = unknown>(key: string) => T | undefined
  /** Read a config value, returning `fallback` when it is `undefined`. */
  getOrDefault: <T = unknown>(key: string, fallback: T) => T
  /** Snapshot of the whole config (seeded with schema defaults). */
  getAll: () => Record<string, unknown>
  /** Validate + persist a single key; rejects if the new value fails the schema. */
  update: (key: string, value: unknown) => Promise<void>
  /** Subscribe to config changes (any source). Returns a disposer. */
  onChange: (listener: (config: Record<string, unknown>) => void) => () => void
}

// =============================================================================
// I18n API - Internationalization
// =============================================================================

/**
 * Supported locales
 */
export type Locale = "en" | "zh-CN"

/**
 * Translation parameters
 */
export type TranslationParams = Record<string, string | number | boolean>

/**
 * I18n API for plugins
 */
export interface PluginI18nAPI {
  /** Get current locale */
  getCurrentLocale: () => Locale

  /** Get available locales */
  getAvailableLocales: () => Locale[]

  /** Get locale display name */
  getLocaleName: (locale: Locale) => string

  /** Translate a key */
  t: (key: string, params?: TranslationParams) => string

  /** Register plugin translations */
  registerTranslations: (locale: Locale, translations: Record<string, string>) => void

  /** Check if a translation key exists */
  hasTranslation: (key: string) => boolean

  /** Subscribe to locale changes */
  onLocaleChange: (handler: (locale: Locale) => void) => () => void

  /** Format date according to locale */
  formatDate: (date: Date, options?: Intl.DateTimeFormatOptions) => string

  /** Format number according to locale */
  formatNumber: (number: number, options?: Intl.NumberFormatOptions) => string

  /** Format relative time */
  formatRelativeTime: (date: Date) => string
}

// =============================================================================
// Canvas API - Document Editing
// =============================================================================

/**
 * Canvas document for editing
 */
export interface PluginCanvasDocument {
  id: string
  sessionId: string
  title: string
  content: string
  language: ArtifactLanguage
  type: "code" | "text"
  createdAt: Date
  updatedAt: Date
  suggestions?: CanvasSuggestion[]
  versions?: CanvasDocumentVersion[]
}

/**
 * Canvas document creation options
 */
export interface CreateCanvasDocumentOptions {
  sessionId?: string
  title: string
  content: string
  language: ArtifactLanguage
  type: "code" | "text"
}

/**
 * Canvas selection
 */
export interface CanvasSelection {
  start: number
  end: number
  text: string
}

/**
 * Canvas API for plugins
 */
export interface PluginCanvasAPI {
  /** Get current canvas document */
  getCurrentDocument: () => PluginCanvasDocument | null

  /** Get a canvas document by ID */
  getDocument: (id: string) => PluginCanvasDocument | null

  /** Create a new canvas document */
  createDocument: (options: CreateCanvasDocumentOptions) => Promise<string>

  /** Update a canvas document */
  updateDocument: (id: string, updates: Partial<PluginCanvasDocument>) => void

  /** Delete a canvas document */
  deleteDocument: (id: string) => void

  /** Open a canvas document */
  openDocument: (id: string) => void

  /** Close the canvas panel */
  closeCanvas: () => void

  /** Get current selection in canvas */
  getSelection: () => CanvasSelection | null

  /** Set selection in canvas */
  setSelection: (start: number, end: number) => void

  /** Insert text at cursor position */
  insertText: (text: string) => void

  /** Replace selected text */
  replaceSelection: (text: string) => void

  /** Get document content */
  getContent: (id?: string) => string

  /** Set document content */
  setContent: (content: string, id?: string) => void

  /** Save a version of the document */
  saveVersion: (id: string, description?: string) => Promise<string>

  /** Restore a version */
  restoreVersion: (documentId: string, versionId: string) => void

  /** Get all versions of a document */
  getVersions: (id: string) => CanvasDocumentVersion[]

  /** Subscribe to canvas changes */
  onCanvasChange: (handler: (doc: PluginCanvasDocument | null) => void) => () => void

  /** Subscribe to content changes */
  onContentChange: (handler: (content: string) => void) => () => void

  // ---------------------------------------------------------------------------
  // Python sandbox (Tauri-only)
  // ---------------------------------------------------------------------------

  /**
   * Run Python code in the bundled sandbox. Throws in web mode.
   * Requires the `canvas:run` permission.
   */
  executePython: (code: string, timeoutMs?: number) => Promise<PythonExecResult>

  // ---------------------------------------------------------------------------
  // AI actions (proxies to lib/ai/generation/canvas-actions)
  // ---------------------------------------------------------------------------

  executeAction: (
    actionType: CanvasActionType,
    content: string,
    config: CanvasActionConfig,
    options?: CanvasActionExecutionOptions
  ) => Promise<CanvasActionResult>

  executeActionStreaming: (
    actionType: CanvasActionType,
    content: string,
    config: CanvasActionConfig,
    callbacks: StreamingCallbacks,
    options?: CanvasActionExecutionOptions
  ) => Promise<void>

  // ---------------------------------------------------------------------------
  // Comments (Dexie-backed)
  // ---------------------------------------------------------------------------

  getComments: (docId: string) => Promise<CanvasComment[]>
  addComment: (input: AddCommentInput) => Promise<CanvasComment>
  updateComment: (commentId: string, content: string) => Promise<void>
  resolveComment: (commentId: string, resolvedBy?: string) => Promise<void>
  replyToComment: (parentId: string, reply: ReplyInput) => Promise<CanvasComment>
  deleteComment: (commentId: string) => Promise<void>

  // ---------------------------------------------------------------------------
  // Collaboration sessions (CRDT + Dexie)
  // ---------------------------------------------------------------------------

  /** Create a new collab session for a document. Requires `canvas:collaborate`. */
  createCollaborationSession: (documentId: string, content: string) => CollaborativeSession
  /** Look up a session by id (in-memory or from Dexie). */
  getCollaborationSession: (sessionId: string) => Promise<CollaborativeSession | undefined>
  /** Active session for the given document, if one exists. */
  getActiveCollaborationSession: (documentId: string) => Promise<CollaborativeSession | undefined>
  /** N most-recent persisted sessions (newest-first). */
  listRecentCollaborationSessions: (limit?: number) => Promise<CollaborativeSession[]>
  /** Soft-close a session (sets isActive=false, drops in-memory state). */
  closeCollaborationSession: (sessionId: string) => void
}

// =============================================================================
// Artifact API - Artifact Management
// =============================================================================

/**
 * Artifact creation options
 */
export interface CreateArtifactOptions {
  title: string
  content: string
  language: ArtifactLanguage
  sessionId?: string
  messageId?: string
  type?: ArtifactType | "text"
  metadata?: Artifact["metadata"]
  /** Namespaced plugin-owned payload descriptor, e.g. `cognia-office/workbook`. */
  kind?: string
  schemaVersion?: number
}

export interface UpdateArtifactOptions {
  title?: string
  content?: string
  metadata?: Artifact["metadata"]
  expectedVersion: number
  changeDescription?: string
}

/**
 * Artifact filter options
 */
export interface ArtifactFilter {
  sessionId?: string
  language?: ArtifactLanguage
  type?: string
  limit?: number
  offset?: number
}

/**
 * Artifact API for plugins
 */
export interface PluginArtifactAPI {
  /** Get active artifact */
  getActiveArtifact: () => Artifact | null

  /** Get an artifact by ID */
  getArtifact: (id: string) => Artifact | null

  /** Create a new artifact */
  createArtifact: (options: CreateArtifactOptions) => Promise<string>

  /** Atomically update a plugin-owned artifact and snapshot its previous version. */
  updateArtifact: (id: string, updates: UpdateArtifactOptions) => Artifact

  /** Delete an artifact */
  deleteArtifact: (id: string) => void

  /** Version history for a plugin-owned artifact. */
  listVersions: (id: string) => import("@/types/artifact").ArtifactVersion[]

  /** Restore a plugin-owned artifact version. */
  restoreVersion: (id: string, versionId: string, expectedVersion: number) => Artifact

  /** List artifacts */
  listArtifacts: (filter?: ArtifactFilter) => Artifact[]

  /** Open artifact panel with specific artifact */
  openArtifact: (id: string) => void

  /** Close artifact panel */
  closeArtifact: () => void

  /** Subscribe to artifact changes */
  onArtifactChange: (handler: (artifact: Artifact | null) => void) => () => void

  /** Register a custom artifact renderer */
  registerRenderer: (type: string, renderer: ArtifactRenderer) => () => void
}

/**
 * Artifact renderer definition
 */
export interface ArtifactRenderer {
  name: string
  mount: (artifact: Artifact, container: HTMLElement) => ArtifactRendererHandle
}

export interface ArtifactRendererHandle {
  update?: (artifact: Artifact) => void
  dispose: () => void
}

export interface PluginFileHandle {
  id: string
  name: string
  mimeType: string
  size: number
  bytes: Uint8Array
}

export interface PluginFilesAPI {
  open: (options?: {
    accept?: string[]
    multiple?: boolean
    maxBytes?: number
  }) => Promise<PluginFileHandle[]>
  save: (options: {
    suggestedName: string
    mimeType: string
    bytes: Uint8Array
  }) => Promise<{ saved: boolean }>
  readAttachment: (handle: string) => Promise<PluginFileHandle>
}

export interface PluginBuiltInSkillSummary {
  id: string
  family: string
  mutation: "read" | "write" | "destructive"
  label: { en: string; "zh-CN": string }
}

export interface PluginSkillsAPI {
  listBuiltIns: (family?: string) => PluginBuiltInSkillSummary[]
  invokeBuiltIn: (
    skillId: string,
    args: Record<string, unknown>,
    options: { sessionId: string; signal?: AbortSignal }
  ) => Promise<import("@/lib/skills/built-in/types").BuiltInSkillResult>
}

// =============================================================================
// Notification Center API
// =============================================================================

/**
 * Notification options
 */
export interface NotificationOptions {
  title: string
  message: string
  type?: "info" | "success" | "warning" | "error"
  duration?: number
  icon?: PluginIconName
  actions?: NotificationAction[]
  persistent?: boolean
  progress?: number
}

/**
 * Notification action
 */
export interface NotificationAction {
  label: string
  action: string
  variant?: "default" | "primary" | "destructive"
}

/**
 * Notification instance
 */
export interface Notification {
  id: string
  title: string
  message: string
  type: "info" | "success" | "warning" | "error"
  createdAt: Date
  actions?: NotificationAction[]
  progress?: number
  persistent: boolean
}

/**
 * Notification Center API for plugins
 */
export interface PluginNotificationCenterAPI {
  /** Create a notification */
  create: (options: NotificationOptions) => string

  /** Update a notification */
  update: (id: string, updates: Partial<NotificationOptions>) => void

  /** Dismiss a notification */
  dismiss: (id: string) => void

  /** Dismiss all notifications */
  dismissAll: () => void

  /** Get all active notifications */
  getAll: () => Notification[]

  /** Subscribe to notification actions */
  onAction: (handler: (id: string, action: string) => void) => () => void

  /** Create a progress notification */
  createProgress: (
    title: string,
    message: string
  ) => {
    id: string
    update: (progress: number, message?: string) => void
    complete: (message?: string) => void
    error: (message: string) => void
  }
}

// =============================================================================
// Storage API - Per-plugin persistent key-value storage
// =============================================================================

/**
 * Per-plugin persistent storage API
 *
 * Each plugin gets an isolated key-value namespace backed by localStorage.
 * Storage is limited to 5MB per plugin.
 */
export interface PluginStorageAPI {
  /** Get a value by key */
  get<T = unknown>(key: string): Promise<T | undefined>
  /** Get a value by key with a default */
  getOrDefault<T = unknown>(key: string, defaultValue: T): Promise<T>
  /** Set a value by key */
  set<T = unknown>(key: string, value: T): Promise<void>
  /** Remove a value by key */
  remove(key: string): Promise<void>
  /** Delete alias for compatibility with legacy PluginStorage */
  delete(key: string): Promise<void>
  /** Check if a key exists */
  has(key: string): Promise<boolean>
  /** Get all keys in this plugin's namespace */
  keys(): Promise<string[]>
  /** Clear all plugin storage */
  clear(): Promise<void>
  /** Get storage usage in bytes (approximate) */
  getUsage(): Promise<number>
  /** Store a value encrypted at rest with the host-managed plugin key. */
  setSecure<T = unknown>(key: string, value: T): Promise<void>
  /** Retrieve and decrypt a value previously written by `setSecure`. */
  getSecure<T = unknown>(key: string): Promise<T | undefined>
  /** Check whether the stored value uses the encrypted envelope. */
  isEncrypted(key: string): Promise<boolean>
}

// =============================================================================
// AI Provider API - Custom AI Providers
// =============================================================================

/**
 * Chat message for AI
 */
export interface AIChatMessage {
  role: "user" | "assistant" | "system"
  content: string
  name?: string
}

/**
 * Chat options
 */
export interface AIChatOptions {
  model?: string
  temperature?: number
  maxTokens?: number
  topP?: number
  stop?: string[]
  stream?: boolean
  /**
   * Cancellation signal. When it aborts, the underlying provider stream is
   * torn down so the plugin stops accruing tokens mid-generation. Forwarded
   * to the built-in fallback provider; custom providers receive it too and
   * may honour it.
   */
  signal?: AbortSignal
}

/**
 * Chat response chunk
 */
export interface AIChatChunk {
  content: string
  finishReason?: "stop" | "length" | "tool_calls"
  usage?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
}

/**
 * AI model definition
 */
export interface AIModel {
  id: string
  name: string
  provider: string
  contextLength: number
  capabilities: ("chat" | "completion" | "embedding" | "vision" | "function_calling")[]
}

/**
 * Custom AI provider definition
 */
export interface AIProviderDefinition {
  id: string
  name: string
  description: string
  icon?: PluginIconName
  models: AIModel[]
  chat: (messages: AIChatMessage[], options?: AIChatOptions) => AsyncIterable<AIChatChunk>
  embed?: (texts: string[]) => Promise<number[][]>
  validateApiKey?: (apiKey: string) => Promise<boolean>
}

/**
 * AI Provider API for plugins
 */
export interface PluginAIProviderAPI {
  /** Register a custom AI provider */
  registerProvider: (provider: AIProviderDefinition) => () => void

  /** Get available models */
  getAvailableModels: () => AIModel[]

  /** Get models for a specific provider */
  getProviderModels: (providerId: string) => AIModel[]

  /** Chat with a model */
  chat: (messages: AIChatMessage[], options?: AIChatOptions) => AsyncIterable<AIChatChunk>

  /** Generate embeddings */
  embed: (texts: string[]) => Promise<number[][]>

  /** Get current default model */
  getDefaultModel: () => string

  /** Get current default provider */
  getDefaultProvider: () => string
}

// =============================================================================
// Extension Points API - UI Extensions
// =============================================================================

/**
 * UI extension points
 */
export type ExtensionPoint = CanonicalExtensionPoint

/**
 * Extension options
 */
export interface ExtensionOptions {
  priority?: number
  /** Plugin i18n key used by contribution discovery UI. */
  labelKey?: string
  condition?: () => boolean
  /**
   * Declarative `when` clause evaluated against the context-key store
   * (`lib/plugin/context-keys/context-key-store`). When set, the extension is
   * only rendered while the clause holds — e.g. `"chat.active && !chat.streaming"`.
   * Combined with `condition` (both must pass). Prefer `when` over `condition`
   * for visibility that depends on app state, so the host re-renders on key
   * changes without a custom subscription.
   */
  when?: string
  /**
   * Inline-size floor for this contribution's box, in CSS pixels.
   *
   * A *request*, not a guarantee: the host clamps it to the slot's own inline
   * size, so a contribution can never be wider than the region hosting it no
   * matter what number is passed. Non-finite and non-positive values are
   * dropped at registration.
   *
   * Declaring either bound has a real cost — the wrapper stops being
   * `display: contents` and starts generating a layout box (see
   * `PluginExtensionBoundary`). In a flex toolbar that turns the contribution
   * from a direct flex child into a nested one. Omit both unless the
   * contribution genuinely needs reserved width.
   */
  minWidth?: number
  /** Inline-size ceiling, in CSS pixels. Same clamping and same cost as `minWidth`. */
  maxWidth?: number
}

/**
 * Extension registration
 */
export interface ExtensionRegistration {
  id: string
  pluginId: string
  point: ExtensionPoint
  component: React.ComponentType<ExtensionProps>
  options: ExtensionOptions
}

/**
 * Props passed to extension components
 */
export interface ExtensionProps {
  pluginId: string
  extensionId: string
  /** Host-declared shape of the slot receiving this contribution. */
  formFactor: PluginSurfaceFormFactor
}

/**
 * Extension Points API for plugins
 */
export interface PluginExtensionAPI {
  /** Register a UI extension */
  registerExtension: (
    point: ExtensionPoint,
    component: React.ComponentType<ExtensionProps>,
    options?: ExtensionOptions
  ) => () => void

  /** Get all extensions for a point */
  getExtensions: (point: ExtensionPoint) => ExtensionRegistration[]

  /** Check if extensions exist for a point */
  hasExtensions: (point: ExtensionPoint) => boolean
}

// =============================================================================
// Permission API - Security
// =============================================================================

/**
 * Plugin API permissions for extended features
 */
export type PluginAPIPermission =
  | "filesystem:read"
  | "filesystem:write"
  | "session:read"
  | "session:write"
  | "session:delete"
  | "project:read"
  | "project:write"
  | "project:delete"
  | "vector:read"
  | "vector:write"
  | "canvas:read"
  | "canvas:write"
  | "canvas:run"
  | "canvas:collaborate"
  | "artifact:read"
  | "artifact:write"
  | "workflow:read"
  | "ai:chat"
  | "ai:embed"
  | "agent:control"
  | "builtin-skills:invoke"
  | "agent:dispatch-external"
  | "agent:dispatch"
  | "agent:shared-memory:read"
  | "twin:read"
  | "templates:read"
  | "templates:contribute"
  | "templates:instantiate"
  | "templates:library:write"
  | "export:session"
  | "export:project"
  | "theme:read"
  | "theme:write"
  | "media:image:read"
  | "media:image:write"
  | "media:video:read"
  | "media:video:write"
  | "media:video:export"
  | "extension:ui"
  | "extension:workflow"
  | "notification:show"
  | "ipc:call"
  | "ipc:expose"
  | "events:publish"
  | "events:subscribe"

/**
 * Permission API for plugins
 */
/**
 * Any permission introspectable through `ctx.permissions`: an API permission
 * (granted via `permissionMapping`) or a manifest-level permission enforced
 * by the `PermissionGuard` (e.g. `git:write`, `terminal:execute`).
 * Introspection consults both stores so it agrees with enforcement.
 */
export type IntrospectablePluginPermission = PluginAPIPermission | PluginPermission

export interface PluginPermissionAPI {
  /** Check if plugin has a permission (API or guard-enforced) */
  hasPermission: (permission: IntrospectablePluginPermission) => boolean

  /** Request a permission from user */
  requestPermission: (permission: PluginAPIPermission, reason?: string) => Promise<boolean>

  /** Get all granted permissions (API and guard-enforced) */
  getGrantedPermissions: () => IntrospectablePluginPermission[]

  /** Check multiple permissions */
  hasAllPermissions: (permissions: IntrospectablePluginPermission[]) => boolean

  /** Check if any permission is granted */
  hasAnyPermission: (permissions: IntrospectablePluginPermission[]) => boolean
}

// =============================================================================
// Plugin Context API
// =============================================================================

/**
 * Plugin context API with all feature-specific APIs
 */
export interface PluginContextAPI {
  /** Session management API */
  session: PluginSessionAPI

  /** Resource-scoped Context Workbench panel registration. */
  contextPanels: import("@/lib/plugin/api/context-panel-api").PluginContextPanelAPI

  /** Live project editor — open files, reflect edits, read the active editor. */
  editor: import("@/lib/plugin/api/editor-api").PluginEditorAPI

  /** Project management API */
  project: PluginProjectAPI

  /** Vector/RAG API */
  vector: PluginVectorAPI

  /** Theme customization API */
  theme: PluginThemeAPI

  /** Export API */
  export: PluginExportAPI

  /** Import API — content importers (symmetric counterpart of `export`). */
  import: PluginImportAPI

  /** Typed access to the plugin's own declarative configuration. */
  configuration: PluginConfigAPI

  /** Internationalization API */
  i18n: PluginI18nAPI

  /** Canvas editing API */
  canvas: PluginCanvasAPI

  /** Artifact management API */
  artifact: PluginArtifactAPI

  /** Cross-platform user-selected and authorized attachment bytes. */
  files: PluginFilesAPI

  /** Controlled access to allowlisted first-party built-in skills. */
  skills: PluginSkillsAPI

  /** Media processing API */
  media: PluginMediaAPI

  /** Notification center API */
  notifications: PluginNotificationCenterAPI

  /** Per-plugin persistent key-value storage */
  storage: PluginStorageAPI

  /** AI provider API */
  ai: PluginAIProviderAPI

  /** UI extension points API */
  extensions: PluginExtensionAPI

  /** Permission management API */
  permissions: PluginPermissionAPI

  /** Unified template catalog, validation, contribution and guarded execution API. */
  templates: import("@/packages/plugin-sdk/src/templates").PluginTemplatesAPI

  /**
   * Message-part renderer API — register a React component for a custom
   * `UIMessage.parts[].type` value. Optional so older plugin builds keep
   * compiling; new code should use it instead of trying to monkey-patch
   * the chat renderer.
   */
  messagePart: import("@/lib/plugin/api/message-part-api").PluginMessagePartAPI

  /**
   * Tool-result renderer API — register the React card that renders this
   * plugin's own MCP tool result in chat. Tool parts are host-owned
   * (`messagePart` reserves the `tool-` prefix), so this is the supported way
   * for a plugin to render its tool's output richly instead of falling through
   * to the generic content-blocks card. Optional for the same back-compat
   * reason as `messagePart`.
   */
  toolResult: import("@/lib/plugin/api/tool-result-api").PluginToolResultAPI
}
