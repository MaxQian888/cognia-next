/**
 * The plugin contract's share of `lib/ai/agent/external/config/presets.ts`, which re-exports these.
 */
import { nanoid } from "nanoid"
import type {
  AcpPermissionMode,
  ExternalAgentConfig,
  ExternalAgentEcosystemSupportTier,
  ExternalAgentProtocol,
  ExternalAgentTransport,
} from "../../../../../types/agent/external-agent"
import { reportRegistryConflict } from "../../../../plugin/contracts/conflict-reporter"

/**
 * Presets that name a runnable command directly.
 *
 * The DeepSeek Harness presets are excluded: they name no binary on PATH and
 * require managed installation and launch preparation. They cannot be used by
 * direct `--backend` paths that only spawn a preset's static process command.
 */
export const NON_EXECUTABLE_PRESET_IDS = [
  "custom",
  "opencode-remote",
  "opencode-v2-service",
  "deepseek-harness-readonly",
  "deepseek-harness-workspace",
  "deepseek-harness-acp",
] as const

/**
 * Available external agent presets
 */
export type ExternalAgentPresetId =
  | "codex"
  | "codex-acp"
  | "codex-app-server"
  | "claude-code"
  | "gemini-cli"
  | "cursor-cli"
  | "copilot-cli"
  | "kiro"
  | "qwen-code"
  | "pi-rpc"
  | "droid"
  | "devin"
  | "minimax-code"
  | "grok"
  | "kimi"
  | "cline"
  | "qoder"
  | "goose"
  | "aider"
  | "opencode-acp"
  | "opencode-server"
  | "opencode-remote"
  | "opencode-v2-service"
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

export interface RegisteredPreset {
  config: ExternalAgentPresetConfig
  pluginId?: string
}

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
// Builtin preset catalog (host-installed)
//
// The static catalog is derived from the host's ecosystem adapters, and the
// Codex probe asks the host whether a command is on PATH; neither can live in
// the contract. The host installs both once
// (`lib/ai/agent/external/config/presets.ts` calls
// `installBuiltinExternalAgentPresets` at module load). Until then the catalog
// is empty and the probe is absent: every read below answers for
// plugin-contributed presets only, and the Codex probe returns its safe
// default. Pinned by `presets.test.ts` in this package.
// ============================================================================

/** What the host supplies: its static preset record and a PATH probe. */
export interface BuiltinExternalAgentPresetCatalog {
  presets: Readonly<Record<ExternalAgentPresetId, ExternalAgentPresetConfig | null>>
  commandExists: (command: string) => Promise<boolean>
}

const builtinPresets: Partial<Record<ExternalAgentPresetId, ExternalAgentPresetConfig | null>> = {}
let commandExists: BuiltinExternalAgentPresetCatalog["commandExists"] | null = null

/**
 * Live view of the host's builtin presets (`custom` maps to `null`). Empty
 * until the host installs its catalog; entries are never mutated in place.
 */
export const EXTERNAL_AGENT_PRESETS: Readonly<
  Partial<Record<ExternalAgentPresetId, ExternalAgentPresetConfig | null>>
> = builtinPresets

/** Host seam: install (or replace) the builtin catalog. */
export function installBuiltinExternalAgentPresets(
  catalog: BuiltinExternalAgentPresetCatalog
): void {
  for (const id of Object.keys(builtinPresets) as ExternalAgentPresetId[]) delete builtinPresets[id]
  Object.assign(builtinPresets, catalog.presets)
  commandExists = catalog.commandExists
}

// ============================================================================
// Preset Utilities
// ============================================================================

/**
 * Get all available preset IDs (excluding `custom`). The result merges the
 * builtin static IDs with every dynamic id contributed by a plugin. The
 * return type is `string[]` rather than `ExternalAgentPresetId[]` because
 * dynamic ids fall outside the closed compile-time union.
 */
export function getAvailablePresets(): string[] {
  const builtins = (Object.keys(builtinPresets) as ExternalAgentPresetId[]).filter(
    (id) => id !== "custom" && builtinPresets[id] != null
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
  return builtinPresets[presetId as ExternalAgentPresetId] ?? null
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
    ...(overrides?.codexOptions !== undefined ? { codexOptions: overrides.codexOptions } : {}),
    ...(overrides?.sandboxPolicy !== undefined ? { sandboxPolicy: overrides.sandboxPolicy } : {}),
    ...(overrides?.cogniaModel !== undefined ? { cogniaModel: overrides.cogniaModel } : {}),
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
  if (builtinPresets[preset as ExternalAgentPresetId]) {
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
  if (!commandExists) return "codex"
  try {
    const hasCodexCli = await commandExists("codex")
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
