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

// ============================================================================
// Preset Types
// ============================================================================

/**
 * Available external agent presets
 */
export type ExternalAgentPresetId = "codex" | "claude-code" | "gemini-cli" | "cursor-cli" | "custom"

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

export const EXTERNAL_AGENT_PRESETS: Record<
  ExternalAgentPresetId,
  ExternalAgentPresetConfig | null
> = {
  codex: buildPresetConfig("codex"),
  "claude-code": buildPresetConfig("claude-code"),
  "gemini-cli": buildPresetConfig("gemini-cli"),
  "cursor-cli": buildPresetConfig("cursor-cli"),
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
