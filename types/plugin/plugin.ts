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
import type { LspServerConfig } from "../lsp/config"
import type { ExternalAgentPresetConfig } from "@/lib/ai/agent/external/presets"
import type { Skill as _Skill } from "./_compat"
import type { PluginMcpServerPresetDef } from "./plugin-mcp-preset"
import type { PluginNativeAnthropicToolDef } from "./plugin-native-tool"
import type { PluginCharacterPackDef } from "./plugin-character-pack"
import type { PluginSchedulerAPI } from "./plugin-scheduler"
import type { PluginSkillDef } from "./plugin-skill"
import type {
  PluginAgentRun,
  PluginAgentRunOptions,
  PluginAgentRunResult,
} from "./plugin-agent-sdk"
import type { PluginVerificationSnapshot } from "./plugin-verification"
import type { PluginOcrProviderDef } from "./plugin-ocr"
import type { PluginWorkspaceBackendDef } from "./plugin-workspace-backend"
import type { PluginMessageRendererDef } from "./plugin-message-renderer"
import type { PluginAiProviderDef } from "./plugin-ai-provider"
import type { PluginTerminalCompletionProviderDef } from "./plugin-terminal-completion"
import type { PluginModalMountDef } from "./plugin-modal"
import type { PluginChatMiddlewareDef } from "./plugin-chat-middleware"
import type { PluginCliToolDef } from "./plugin-cli-tool"
import type { PluginRoutingStrategyDef } from "./plugin-routing-strategy"
import type { PluginDeploymentFilterDef } from "./plugin-deployment-filter"
import type { PluginProtocolAdapterDef } from "./plugin-protocol-adapter"
import type { PluginToolRouteDef } from "./plugin-tool-route"
// `ActivationEventDeclaration` lives in `lib/plugin/contracts/plugin-points`,
// added by Task #10. Importing the real type keeps the manifest schema and
// the runtime parser in lockstep — historically a local alias was used to
// avoid a dep cycle, but the contracts module has no upward imports so the
// real type is safe to bring in here.
import type { ActivationEventDeclaration } from "@/lib/plugin/contracts/plugin-points"
import type { VsCodeExtensionBlock } from "./plugin-vscode"

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
  | "a2ui" // A2UI integration
  | "python" // Python runtime capability
  | "scheduler" // Provides scheduled tasks
  | "external-agent-preset" // cognia-next: contributes external-agent presets (Claude Code / Codex / etc.)
  | "mcp-server-preset" // Contributes MCP server presets to the gallery
  | "connectors" // Provides Platform Connector adapters (Task 110)
  | "workflow" // Contributes custom workflow node executors (ADR 0017)
  | "workflow-trigger" // Contributes custom workflow trigger sources (ADR 0017)
  | "tray" // Contributes items to the desktop system tray menu (ADR-pending)
  | "lsp-server" // Contributes a Language Server (Phase B of LSP reuse)
  | "theme-pack" // Bundles colors + fonts + wallpapers + density into a single applyable pack
  | "fonts" // Contributes font families bundled in plugin assets (@font-face injection)
  | "wallpapers" // Contributes built-in wallpaper entries (bundled images/gradients/colors)
  | "character-pack" // Bundles ready-to-use characters into a portable pack (ADR-0030)
  | "subagent" // Contributes Claude SDK subagents callable by teams + workflow editor
  | "agent-team-template" // Contributes complete agent-team blueprints surfaced in the team picker
  | "shared-memory-adapter" // Contributes a bidirectional backing store for agent-team shared memory
  | "workflow-template" // Contributes complete visual-workflow blueprints surfaced in the editor (ADR-0017/0032)
  | "automation" // Drives the desktop via Computer Use (screenshot/click/type/…) — gates ctx.automation
  | "companion" // Manages paired devices + remote-control grants — gates ctx.companion
  | "quick-action" // Contributes quick actions surfaced in the command palette / composer menu / tray
  | "cli-tools" // Declaratively wraps external CLI binaries as agent tools (manifest.cliTools)

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
  | "agent:control" // Control agent execution (tool-enabled headless runs)
  | "agent:dispatch-external" // Dispatch external coding agents (Claude Code / Codex / …)
  | "python:execute" // Execute Python code
  | "sandbox:web-execute" // Execute code in browser sandbox (Pyodide/JS)
  | "secrets:read" // Read from OS keyring / secure storage
  | "secrets:write" // Write to OS keyring / secure storage
  | "terminal:spawn" // Open a new PTY session in the integrated terminal dock
  | "terminal:write" // Pipe bytes into an existing terminal session's stdin
  | "terminal:kill" // Signal-terminate an existing terminal session
  | "terminal:completion" // Contribute inline command completions + read the in-progress input line
  | "terminal:safety" // Contribute command-safety rules + classify command risk for Auto-mode
  | "git:read" // Read the active source-control repository (status/log/diff/branches)
  | "git:write" // Mutate the active repo (stage/commit/checkout/push/stash/discard)
  | "goal:read" // Read the user's goals and their progress
  | "goal:write" // Create, update, complete, and decompose goals
  | "subscription:read" // Read subscription plan + usage metrics (never raw credentials)
  | "perf:read" // Read performance dashboard snapshots + live sample stream
  | "connectors:read" // List connector adapters + subscribe to inbound bus events
  | "connectors:send" // Send outbound messages through a connector adapter
  | "connectors:manage" // Create / update / delete / enable connector adapter instances
  | "share:read" // Read the local mirror of created public share links + their stats
  | "share:create" // Create / revoke public share links (publishes data to the share worker)
  | "backup:read" // Build + read encrypted backup packages and the backup history
  | "backup:write" // Restore a backup package (overwrites local data)
  // Desktop automation (Computer Use) — drives the real desktop. All DANGEROUS.
  // Reuses the host Rust gate→policy→consent→audit pipeline (surface:"plugin").
  | "automation:screenshot" // Capture desktop screenshots / regions
  | "automation:read" // Read a11y tree, find elements, cursor position, pick-at-point
  | "automation:click" // Mouse click / double / triple / button down-up
  | "automation:type" // Keyboard input, key chords, hold-key
  | "automation:pointer" // Mouse move, drag, scroll
  | "automation:window" // Window focus / close / minimize / maximize / resize
  // Companion remote-control management (host-side). read is sensitive, control is DANGEROUS.
  | "companion:read" // List paired devices, read remote-control grants + inbound activity
  | "companion:control" // Grant / revoke a device's remote-control capability
  | "cli:execute" // Run an allowlisted external CLI declared via manifest.cliTools — DANGEROUS
  | "companion:goal-control" // Pause / resume / stop a host goal loop

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

  /** Default configuration values */
  defaultConfig?: Record<string, unknown>

  // Permissions
  /** Required permissions */
  permissions?: PluginPermission[]

  /** Optional permissions (requested at runtime) */
  optionalPermissions?: PluginPermission[]

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
   * sandbox runners). Registered with the workspace-backend-registry; the
   * legacy `setE2BBackend` singleton becomes a `@deprecated` shim that
   * delegates to the same registry. Permission gate: `process:spawn` +
   * `filesystem:write`.
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
   * namespaced id `${pluginId}:${id}` (synthetic module-bridge key —
   * field-driven, no capability tag).
   */
  routingStrategies?: PluginRoutingStrategyDef[]

  /**
   * Plugin-contributed pre-call deployment filters (LiteLLM
   * optional_pre_call_checks analog). ADR-0026 lazy-factory entries
   * registered into the deployment-filter registry on enable under the
   * namespaced id `${pluginId}:${id}` (synthetic module-bridge key —
   * field-driven, no capability tag). Users opt them into the routing
   * chain via `RoutingConfig.filterChain`.
   */
  deploymentFilters?: PluginDeploymentFilterDef[]

  /**
   * Plugin-contributed outbound protocol adapters: declarative
   * `openai-compatible-variant` specs registered under `${pluginId}:${id}`
   * and forwarded to the sidecar per-send (synthetic module-bridge key —
   * field-driven, no capability tag). Pure data; no plugin code ever loads
   * into the sidecar process.
   */
  protocolAdapters?: PluginProtocolAdapterDef[]

  /**
   * Semantic tool routes: example utterances attached to this plugin's
   * tools, persisted into the `toolRoutes` table on enable and consumed
   * by the opt-in semantic tool-routing matcher (synthetic module-bridge
   * key — field-driven, no capability tag).
   */
  toolRoutes?: PluginToolRouteDef[]

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
  /** One-line description shown in the palette. */
  description?: string
  /** Lucide icon name; resolved by the renderer. */
  icon?: string
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
  targetType: "sub_agent" | "team" | "background"
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

  /** Chat-middleware registration (ADR-0026 §4 §A). */
  chat?: import("@/lib/plugin/api/chat-api").PluginChatAPI

  /** Platform-capability flags (ADR-0026 §5 §C). */
  capabilities?: import("@/lib/plugin/api/capabilities-api").PluginCapabilitiesAPI
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
 * Tray menu item contributed by a plugin. Mirrors `ContextMenuItem` but
 * targets the system-tray surface rather than the right-click context menu.
 */
export interface PluginTrayItemInput {
  /** Local id — the host prefixes it with the plugin id before recording. */
  id: string
  label: string
  /** Optional Lucide icon name; resolved by the renderer. */
  icon?: string
  /** Optional `when` expression evaluated by `lib/tray/when.ts`. */
  when?: string
  /** Free-form category used by `lib/tray/all-commands.ts` for grouping. */
  category?: string
  /** Optional accelerator hint, cosmetic. */
  accelerator?: string
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
