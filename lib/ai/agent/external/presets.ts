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
// Preset Utilities
// ============================================================================

/**
 * Get all available preset IDs (excluding custom)
 */
export function getAvailablePresets(): ExternalAgentPresetId[] {
  return (Object.keys(EXTERNAL_AGENT_PRESETS) as ExternalAgentPresetId[]).filter(
    (id) => id !== "custom" && EXTERNAL_AGENT_PRESETS[id] !== null
  )
}

/**
 * Get preset configuration by ID
 */
export function getPresetConfig(presetId: ExternalAgentPresetId): ExternalAgentPresetConfig | null {
  return EXTERNAL_AGENT_PRESETS[presetId]
}

/**
 * Create a full agent configuration from a preset
 * @param presetId Preset identifier
 * @param overrides Optional configuration overrides
 * @returns Full agent configuration or null if preset not found
 */
export function createAgentFromPreset(
  presetId: ExternalAgentPresetId,
  overrides?: Partial<ExternalAgentConfig>
): ExternalAgentConfig | null {
  const preset = EXTERNAL_AGENT_PRESETS[presetId]
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
 * Check if an agent was created from a preset
 */
export function isFromPreset(config: ExternalAgentConfig): ExternalAgentPresetId | null {
  const preset = config.metadata?.preset as ExternalAgentPresetId | undefined
  if (preset && preset in EXTERNAL_AGENT_PRESETS) {
    return preset
  }
  return null
}

/**
 * Get display info for a preset (for UI)
 */
export function getPresetDisplayInfo(presetId: ExternalAgentPresetId): {
  name: string
  description: string
  envVarHint?: string
  setupHint?: string
  docsUrl?: string
  tags: string[]
} | null {
  const preset = EXTERNAL_AGENT_PRESETS[presetId]
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
