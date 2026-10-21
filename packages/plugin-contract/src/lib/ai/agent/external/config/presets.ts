/**
 * The plugin contract's share of `lib/ai/agent/external/config/presets.ts`, which re-exports these.
 */
import type {
  AcpPermissionMode,
  ExternalAgentEcosystemSupportTier,
  ExternalAgentProtocol,
  ExternalAgentTransport,
} from "../../../../../types/agent/external-agent"

/**
 * Presets that name a runnable command directly.
 *
 * The DeepSeek Harness presets are excluded: they name no binary on PATH and
 * require managed installation and launch preparation. They cannot be used by
 * direct `--backend` paths that only spawn a preset's static process command.
 */
export const NON_EXECUTABLE_PRESET_IDS = [
  "custom",
  "opencode-server",
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
