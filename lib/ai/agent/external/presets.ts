/**
 * External Agent Presets
 *
 * Predefined configurations for popular external AI agents.
 * Allows quick setup of Codex, Claude Code, and other ACP-compatible agents.
 */

import type {
  ExternalAgentConfig,
  ExternalAgentEcosystemSupportTier,
  ExternalAgentProtocol,
  ExternalAgentTransport,
  AcpPermissionMode,
} from "@/types/agent/external-agent"
import { nanoid } from "nanoid"
import { findExternalAgentSurfaceByPresetId } from "./ecosystem-adapters"
import { checkExternalAgentCommandExists } from "@/lib/native/external-agent"

// ============================================================================
// Preset Types
// ============================================================================

/**
 * Available external agent presets
 */
export type ExternalAgentPresetId =
  | "codex"
  | "codex-app-server"
  | "claude-code"
  | "gemini-cli"
  | "cursor-cli"
  | "copilot-cli"
  | "kiro"
  | "qwen-code"
  | "pi"
  | "pi-rpc"
  | "droid"
  | "opencode-acp"
  | "opencode-server"
  | "opencode-remote"
  | "opencode-v2-preview"
  | "deepseek-harness-readonly"
  | "deepseek-harness-workspace"
  | "deepseek-harness-acp"
  | "custom"

/**
 * Preset configuration definition
 */
export interface ExternalAgentPresetConfig {
  /** Display name */
  name: string
  /** Description */
  description: string
  /** Protocol type */
  protocol: ExternalAgentProtocol
  /** Transport type */
  transport: ExternalAgentTransport
  /** Process configuration for stdio transport */
  process?: {
    command: string
    args: string[]
    env?: Record<string, string>
  }
  /** Network configuration for http/websocket transport */
  network?: {
    endpoint: string
  }
  /**
   * Extra metadata merged into the materialized agent config. Used by the
   * OpenCode presets to carry `autoSpawnServer` / `port` so a single preset
   * pick produces a runnable auto-spawn config.
   */
  metadata?: Record<string, unknown>
  /** Hint for required environment variables */
  envVarHint?: string
  /** Setup hint for non-env based prerequisites */
  setupHint?: string
  /** Official docs URL for this preset surface */
  docsUrl?: string
  /** Source adapter identifier */
  adapterId?: string
  /** Source integration surface identifier */
  surfaceId?: string
  /** Ecosystem support tier */
  supportTier?: ExternalAgentEcosystemSupportTier
  /** Default permission mode */
  defaultPermissionMode: AcpPermissionMode
  /** Tags for categorization */
  tags: string[]
  /** Icon identifier */
  icon?: string
}

// ============================================================================
// Preset Definitions
// ============================================================================

/**
 * Predefined external agent configurations
 */
function buildPresetConfig(
  presetId: Exclude<ExternalAgentPresetId, "custom">
): ExternalAgentPresetConfig {
  const resolved = findExternalAgentSurfaceByPresetId(presetId)
  if (!resolved) {
    throw new Error(`Unknown external-agent preset "${presetId}"`)
  }

  const { adapter, surface } = resolved

  return {
    name: surface.name,
    description: surface.description,
    protocol: surface.protocol,
    transport: surface.transport,
    process: surface.process,
    network: surface.network,
    envVarHint: surface.envVarHint,
    setupHint: surface.setupHint,
    docsUrl: surface.docsUrl ?? adapter.docsUrl,
    adapterId: adapter.id,
    surfaceId: surface.id,
    supportTier: surface.supportTier,
    defaultPermissionMode: surface.defaultPermissionMode,
    tags: surface.tags,
    icon: surface.icon,
  }
}

/**
 * OpenCode is a protocol (HTTP + SSE via `@opencode-ai/sdk`), not an ecosystem
 * product surface, so these presets are authored as literals rather than
 * derived from `buildPresetConfig`. The "server" preset auto-spawns
 * `opencode serve` on desktop; the "remote" preset connects to an
 * already-running server endpoint.
 */
const OPENCODE_SERVER_PRESET: ExternalAgentPresetConfig = {
  name: "OpenCode (auto-spawn)",
  description: "Launch a local `opencode serve` process and connect to it (desktop only).",
  protocol: "opencode",
  transport: "sse",
  // `spawnServer` in opencode-client.ts already prepends "serve" (plus
  // --hostname/--port); keep args empty so the CLI doesn't receive a duplicate
  // positional "serve" argument.
  process: { command: "opencode", args: [] },
  metadata: { autoSpawnServer: true },
  setupHint: "Requires the OpenCode CLI on PATH and the Cognia desktop app.",
  docsUrl: "https://opencode.ai/docs/server/",
  supportTier: "executable",
  defaultPermissionMode: "default",
  tags: ["opencode", "sdk", "local"],
}

const OPENCODE_REMOTE_PRESET: ExternalAgentPresetConfig = {
  name: "OpenCode (remote server)",
  description: "Connect to an already-running OpenCode server over HTTP + SSE.",
  protocol: "opencode",
  transport: "sse",
  network: { endpoint: "http://127.0.0.1:4096" },
  setupHint: "Start a server with `opencode serve` (optionally OPENCODE_SERVER_PASSWORD).",
  docsUrl: "https://opencode.ai/docs/server/",
  supportTier: "executable",
  defaultPermissionMode: "default",
  tags: ["opencode", "sdk", "remote"],
}

const OPENCODE_ACP_PRESET: ExternalAgentPresetConfig = {
  name: "OpenCode (ACP)",
  description: "Run OpenCode through its official ACP stdio server.",
  protocol: "acp",
  transport: "stdio",
  process: { command: "opencode", args: ["acp"] },
  setupHint:
    "Requires OpenCode v1.18.14 or newer on PATH; authenticate with `opencode auth login`.",
  docsUrl: "https://opencode.ai/docs/acp/",
  supportTier: "executable",
  defaultPermissionMode: "default",
  tags: ["opencode", "acp", "stdio", "local"],
}

const OPENCODE_V2_PREVIEW_PRESET: ExternalAgentPresetConfig = {
  name: "OpenCode V2 legacy preview contract",
  description:
    "Documents Cognia's pinned legacy preview contract; current OpenCode V2 builds are not compatible.",
  protocol: "opencode-v2",
  transport: "sse",
  metadata: { preview: true, localServiceDiscovery: true },
  setupHint:
    "Not executable against current OpenCode V2 builds. Use stable OpenCode HTTP/SSE or ACP until the preview client is regenerated.",
  docsUrl: "https://opencode.ai/v2/docs/build/client",
  supportTier: "documented-only",
  defaultPermissionMode: "default",
  tags: ["opencode", "v2", "beta", "preview", "local-service"],
}

/**
 * DeepSeek Harness presets.
 *
 * Unlike every other preset here, these name no binary on PATH. DSH publishes
 * no executable for this transport, so Cognia ships its own host composition
 * and launcher (`runtime/deepseek-harness/`) into an isolated runtime home. The
 * installer fills in `process.command` / `process.args` with absolute paths;
 * until then `isExternalAgentExecutable` reports the agent as not runnable and
 * the UI offers Install.
 */
const DEEPSEEK_HARNESS_READONLY_PRESET: ExternalAgentPresetConfig = {
  name: "DeepSeek Harness (read-only)",
  description:
    "Observation-rich DeepSeek Harness runtime: full tool, reasoning, usage, and subagent events. Reads files but cannot modify them or run commands, and cannot ask for approval mid-turn.",
  protocol: "dsh-sdk",
  transport: "stdio",
  // Filled in by the installer; empty args keep the agent non-executable until
  // a certified runtime is actually present.
  process: { command: "", args: [] },
  metadata: { dshProfileId: "cognia-sdk-readonly", requiresManagedRuntime: true },
  envVarHint: "DEEPSEEK_API_KEY",
  setupHint:
    "Install the managed DeepSeek Harness runtime first (Settings → Agents, or `cognia-agent backend install deepseek-harness`).",
  docsUrl: "https://github.com/deepseek-ai/deepseek-harness",
  supportTier: "executable",
  // The transport cannot carry a permission request, so no mode that depends on
  // asking would be honest here.
  defaultPermissionMode: "plan",
  tags: ["deepseek", "sdk", "read-only", "experimental"],
}

const DEEPSEEK_HARNESS_WORKSPACE_PRESET: ExternalAgentPresetConfig = {
  name: "DeepSeek Harness (workspace write)",
  description:
    "DeepSeek Harness with workspace-write authority and a shell. Everything it may do is granted at launch and cannot be revoked mid-turn on this transport.",
  protocol: "dsh-sdk",
  transport: "stdio",
  process: { command: "", args: [] },
  metadata: { dshProfileId: "cognia-sdk-workspace", requiresManagedRuntime: true },
  envVarHint: "DEEPSEEK_API_KEY",
  setupHint:
    "Install the managed runtime first. On Linux this profile also needs a node-gyp toolchain: upstream ships no node-pty prebuild there.",
  docsUrl: "https://github.com/deepseek-ai/deepseek-harness",
  supportTier: "executable",
  defaultPermissionMode: "acceptEdits",
  tags: ["deepseek", "sdk", "workspace-write", "experimental"],
}

/**
 * The interactive DeepSeek Harness channel.
 *
 * Uses Cognia's existing `AcpClientAdapter`; upstream's server negotiates
 * protocol version 1, which is what `SUPPORTED_ACP_PROTOCOL_VERSIONS` accepts.
 *
 * The trade against the SDK presets is severe and deliberate. Upstream calls
 * this server "automation-only": committed assistant text is all that reaches
 * the wire, so there is no streaming, no tool activity, no reasoning and no
 * usage. What it buys is the one thing the SDK transport cannot do — answer a
 * permission request mid-turn, and cancel a single turn without killing the
 * runtime.
 */
const DEEPSEEK_HARNESS_ACP_PRESET: ExternalAgentPresetConfig = {
  name: "DeepSeek Harness (interactive)",
  description:
    "DeepSeek Harness over ACP. Asks you to approve individual tool calls and can cancel a single turn, but reports only committed replies — no streaming, tool activity, reasoning, or usage.",
  protocol: "acp",
  transport: "stdio",
  // Filled in by the installer, like the SDK presets: there is no binary here.
  process: { command: "", args: [] },
  metadata: { dshProfileId: "cognia-acp", requiresManagedRuntime: true },
  envVarHint: "DEEPSEEK_API_KEY",
  setupHint:
    "Install the managed DeepSeek Harness runtime first (Settings → Agents, or `cognia-agent backend install deepseek-harness`).",
  docsUrl: "https://github.com/deepseek-ai/deepseek-harness",
  supportTier: "executable",
  // This is the one DSH channel that can actually carry the question.
  defaultPermissionMode: "default",
  tags: ["deepseek", "acp", "interactive", "experimental"],
}

export const EXTERNAL_AGENT_PRESETS: Record<
  ExternalAgentPresetId,
  ExternalAgentPresetConfig | null
> = {
  codex: buildPresetConfig("codex"),
  "codex-app-server": buildPresetConfig("codex-app-server"),
  "claude-code": buildPresetConfig("claude-code"),
  "gemini-cli": buildPresetConfig("gemini-cli"),
  "cursor-cli": buildPresetConfig("cursor-cli"),
  "copilot-cli": buildPresetConfig("copilot-cli"),
  kiro: buildPresetConfig("kiro"),
  "qwen-code": buildPresetConfig("qwen-code"),
  pi: buildPresetConfig("pi"),
  "pi-rpc": buildPresetConfig("pi-rpc"),
  droid: buildPresetConfig("droid"),
  "opencode-acp": OPENCODE_ACP_PRESET,
  "opencode-server": OPENCODE_SERVER_PRESET,
  "opencode-remote": OPENCODE_REMOTE_PRESET,
  "opencode-v2-preview": OPENCODE_V2_PREVIEW_PRESET,
  "deepseek-harness-readonly": DEEPSEEK_HARNESS_READONLY_PRESET,
  "deepseek-harness-workspace": DEEPSEEK_HARNESS_WORKSPACE_PRESET,
  "deepseek-harness-acp": DEEPSEEK_HARNESS_ACP_PRESET,
  custom: null,
}

// ============================================================================
// Runtime preset overlay (§A-3)
//
// Plugins contribute external-agent presets through the `external-agent-preset`
// capability. Rather than mutating the static `EXTERNAL_AGENT_PRESETS` Record
// (which would change the closed `ExternalAgentPresetId` union and break every
// consumer), the plugin runtime registers presets into this in-memory overlay.
// All read paths consult both maps; the static record stays authoritative for
// the four shipping ids so disabling a plugin never removes a builtin preset.
//
// Registration is idempotent: re-registering the same id replaces the previous
// entry. Conflicts between static and dynamic ids are resolved with
// dynamic-wins so a plugin can shadow a builtin preset (e.g., to inject a
// preferred command path) — but the legacy static entry is preserved as the
// fallback when the plugin is disabled.
// ============================================================================

import { reportRegistryConflict } from "@/lib/plugin/contracts/conflict-reporter"

interface RegisteredPreset {
  config: ExternalAgentPresetConfig
  pluginId?: string
}

const dynamicPresets = new Map<string, RegisteredPreset>()

/**
 * Register a preset at runtime. Plugins call this through the plugin manager;
 * tests call it directly. Returns the previously registered entry (if any) so
 * higher-level code can detect collisions.
 */
export function registerPreset(
  id: string,
  config: ExternalAgentPresetConfig,
  opts?: { pluginId?: string }
): RegisteredPreset | undefined {
  const previous = dynamicPresets.get(id)
  // W4.2 first-wins-cross-plugin: a DIFFERENT plugin re-using a dynamic id is
  // rejected (the incumbent wins) so plugin B can't hijack plugin A's preset
  // and B's disable can't drop A's entry. Same-plugin refresh (hot reload)
  // and static-id shadowing (dynamic-over-static, documented above) keep
  // their existing semantics.
  if (previous && previous.pluginId !== opts?.pluginId) {
    reportRegistryConflict({
      pluginId: opts?.pluginId ?? "unknown",
      attemptedId: id,
      registry: "external-agent-preset",
      winnerPluginId: previous.pluginId,
    })
    return previous
  }
  dynamicPresets.set(id, { config, pluginId: opts?.pluginId })
  return previous
}

/** Drop a single dynamically registered preset. Returns true if removed. */
export function unregisterPreset(id: string): boolean {
  return dynamicPresets.delete(id)
}

/**
 * Drop every dynamic preset tagged with `pluginId`. Returns the number of
 * presets removed. Called by the plugin manager during plugin disable /
 * uninstall so a single plugin's contributions are cleaned up in one shot.
 */
export function unregisterPresetsByPlugin(pluginId: string): number {
  let removed = 0
  for (const [id, entry] of dynamicPresets) {
    if (entry.pluginId === pluginId) {
      dynamicPresets.delete(id)
      removed += 1
    }
  }
  return removed
}

/**
 * Test-only escape hatch: clear every dynamic preset so test isolation can
 * reset the overlay without touching the static record. Production code
 * should never need this — `unregisterPresetsByPlugin` is the supported path.
 */
export function __resetDynamicPresetsForTesting(): void {
  dynamicPresets.clear()
}

/** Returns the (pluginId, config) for a dynamic preset, or undefined. */
export function getDynamicPresetEntry(id: string): RegisteredPreset | undefined {
  return dynamicPresets.get(id)
}

/**
 * Returns every dynamically-registered preset entry (`id + config + pluginId`)
 * in registration order. Used by the Plugin Detail Sheet's Contributed tab to
 * enumerate the presets a single plugin contributed.
 */
export function listDynamicPresetEntries(): Array<{
  id: string
  config: ExternalAgentPresetConfig
  pluginId?: string
}> {
  return Array.from(dynamicPresets, ([id, entry]) => ({
    id,
    config: entry.config,
    pluginId: entry.pluginId,
  }))
}

// ============================================================================
// Preset Utilities
// ============================================================================

/**
 * The builtin *executable* external-agent preset ids — every static preset
 * except the `custom` sentinel and service-discovered preview integrations.
 * These are exactly the ids a teammate `runtime` or a subagent `externalPresetId`
 * may name; plugin-contributed presets stay outside this closed set and are
 * reached through the capability overlay instead. Derived from the record so it
 * can never drift from `EXTERNAL_AGENT_PRESETS`.
 */
/**
 * Presets that name a runnable command directly.
 *
 * The DeepSeek Harness presets are excluded: they name no binary on PATH and
 * only become runnable once the managed runtime is installed, at which point
 * the installer writes absolute paths into the agent config. Listing them as
 * executable would offer them as `--backend` choices that cannot spawn.
 */
const NON_EXECUTABLE_PRESET_IDS = [
  "custom",
  "opencode-v2-preview",
  "deepseek-harness-readonly",
  "deepseek-harness-workspace",
  "deepseek-harness-acp",
] as const

/**
 * Preset ids with no fixed executable backend.
 *
 * Exported because `TeammateRuntime` is defined as the complement of this set.
 * It used to hand-copy the exclusion list, which silently absorbed the three
 * DeepSeek Harness ids the moment they were added here — offering runtimes the
 * teammate picker (built from {@link BUILTIN_EXECUTABLE_PRESET_IDS}) can never
 * list. Deriving both from one source keeps them the same set by construction.
 */
export type NonExecutablePresetId = (typeof NON_EXECUTABLE_PRESET_IDS)[number]

export const BUILTIN_EXECUTABLE_PRESET_IDS = (
  Object.keys(EXTERNAL_AGENT_PRESETS) as ExternalAgentPresetId[]
).filter(
  (id): id is Exclude<ExternalAgentPresetId, NonExecutablePresetId> =>
    !(NON_EXECUTABLE_PRESET_IDS as readonly string[]).includes(id) &&
    EXTERNAL_AGENT_PRESETS[id] !== null
)

/**
 * Get all available preset IDs (excluding `custom`). The result merges the
 * builtin static IDs with every dynamic id contributed by a plugin. The
 * return type is `string[]` rather than `ExternalAgentPresetId[]` because
 * dynamic ids fall outside the closed compile-time union.
 */
export function getAvailablePresets(): string[] {
  const builtins = (Object.keys(EXTERNAL_AGENT_PRESETS) as ExternalAgentPresetId[]).filter(
    (id) => id !== "custom" && EXTERNAL_AGENT_PRESETS[id] !== null
  )
  const dynamic = Array.from(dynamicPresets.keys()).filter((id) => !builtins.includes(id as never))
  return [...builtins, ...dynamic]
}

/**
 * Presets that may be selected for execution. Documented-only entries remain
 * discoverable through {@link getAvailablePresets} for guidance surfaces, but
 * must never enter a launch picker or CLI backend list.
 */
export function getRunnablePresets(): string[] {
  return getAvailablePresets().filter(
    (id) => getPresetConfig(id)?.supportTier !== "documented-only"
  )
}

/**
 * Get preset configuration by ID. Dynamic (plugin) presets take precedence
 * over builtin static presets so a plugin can shadow a builtin entry; if the
 * plugin is later disabled the static entry remains as fallback.
 */
export function getPresetConfig(presetId: string): ExternalAgentPresetConfig | null {
  const dynamic = dynamicPresets.get(presetId)
  if (dynamic) return dynamic.config
  return EXTERNAL_AGENT_PRESETS[presetId as ExternalAgentPresetId] ?? null
}

/**
 * Create a full agent configuration from a preset
 * @param presetId Preset identifier (builtin id or plugin-registered id)
 * @param overrides Optional configuration overrides
 * @returns Full agent configuration or null if preset not found
 */
export function createAgentFromPreset(
  presetId: string,
  overrides?: Partial<ExternalAgentConfig>
): ExternalAgentConfig | null {
  // Route through `getPresetConfig` so plugin-contributed presets resolve too.
  const preset = getPresetConfig(presetId)
  if (!preset) {
    return null
  }

  const id = overrides?.id || nanoid()
  const now = new Date()

  return {
    id,
    name: overrides?.name || preset.name,
    description: overrides?.description || preset.description,
    protocol: preset.protocol,
    transport: preset.transport,
    enabled: overrides?.enabled ?? true,
    process: preset.process
      ? {
          command: overrides?.process?.command || preset.process.command,
          args: overrides?.process?.args || preset.process.args,
          env: { ...preset.process.env, ...overrides?.process?.env },
          cwd: overrides?.process?.cwd,
        }
      : undefined,
    network: preset.network
      ? {
          endpoint: overrides?.network?.endpoint || preset.network.endpoint,
          ...overrides?.network,
        }
      : overrides?.network,
    defaultPermissionMode: overrides?.defaultPermissionMode || preset.defaultPermissionMode,
    tags: [...preset.tags, ...(overrides?.tags || [])],
    timeout: overrides?.timeout || 30000,
    metadata: {
      preset: presetId,
      ecosystemAdapterId: preset.adapterId,
      ecosystemSurfaceId: preset.surfaceId,
      ecosystemSupportTier: preset.supportTier,
      ecosystemDocsUrl: preset.docsUrl,
      ...preset.metadata,
      ...overrides?.metadata,
    },
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * Check if an agent was created from a preset. Returns the preset id (which
 * may be a static `ExternalAgentPresetId` or a plugin-registered string id) if
 * the metadata refers to any known preset, or `null` otherwise.
 */
export function isFromPreset(config: ExternalAgentConfig): string | null {
  const preset = config.metadata?.preset
  if (typeof preset !== "string") return null
  if (preset in EXTERNAL_AGENT_PRESETS && EXTERNAL_AGENT_PRESETS[preset as ExternalAgentPresetId]) {
    return preset
  }
  if (dynamicPresets.has(preset)) {
    return preset
  }
  return null
}

/**
 * Pick the preferred *executable* Codex preset. The native `codex app-server`
 * runtime is preferred when the official `codex` CLI is on PATH; otherwise we
 * fall back to the ACP shim (`codex`, run via `npx` — no local install needed).
 *
 * Drives the gallery's "Recommended" hint so adding Codex automatically prefers
 * the first-party protocol when it is available, and degrades gracefully when
 * it isn't. Returns `"codex"` on any detection failure (the safe default).
 */
export async function resolvePreferredCodexExecutablePresetId(): Promise<
  "codex" | "codex-app-server"
> {
  try {
    const hasCodexCli = await checkExternalAgentCommandExists("codex")
    return hasCodexCli ? "codex-app-server" : "codex"
  } catch {
    return "codex"
  }
}

/**
 * Get display info for a preset (for UI). Resolves through `getPresetConfig`
 * so dynamic (plugin) presets surface in the same UI as builtins.
 */
export function getPresetDisplayInfo(presetId: string): {
  name: string
  description: string
  envVarHint?: string
  setupHint?: string
  docsUrl?: string
  tags: string[]
} | null {
  const preset = getPresetConfig(presetId)
  if (!preset) return null

  return {
    name: preset.name,
    description: preset.description,
    envVarHint: preset.envVarHint,
    setupHint: preset.setupHint,
    docsUrl: preset.docsUrl,
    tags: preset.tags,
  }
}
