/**
 * External Agent Presets
 *
 * Predefined configurations for popular external AI agents.
 * Allows quick setup of Codex, Claude Code, and other ACP-compatible agents.
 */

import { findExternalAgentSurfaceByPresetId } from "../ecosystem-adapters"
import { checkExternalAgentCommandExists } from "@/lib/native/external-agent"

// ============================================================================
// Preset Types
// ============================================================================

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
  setupHint:
    "Requires an OpenCode V1 CLI and a Cognia process host. Use OpenCode V2 for the current service API.",
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
  supportTier: "documented-only",
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
    "Requires the current @opencode/cli (2.0.0 or newer) on PATH; authenticate in OpenCode.",
  docsUrl: "https://opencode.ai/docs/acp/",
  supportTier: "executable",
  defaultPermissionMode: "default",
  tags: ["opencode", "acp", "stdio", "local"],
}

const OPENCODE_V2_SERVICE_PRESET: ExternalAgentPresetConfig = {
  name: "OpenCode V2",
  description:
    "Connect to the current OpenCode service over HTTP and SSE, using local discovery or an explicit endpoint.",
  protocol: "opencode-v2",
  transport: "sse",
  metadata: { localServiceDiscovery: true },
  setupHint:
    "Run the current OpenCode service, or configure its endpoint. Local discovery requires the Cognia desktop service bridge.",
  docsUrl: "https://opencode.ai/v2/docs/build/client",
  supportTier: "executable",
  defaultPermissionMode: "default",
  tags: ["opencode", "v2", "local-service"],
}

/**
 * DeepSeek Harness presets.
 *
 * These presets use Cognia's pinned official DSH runtime and owned launch
 * profiles (`runtime/deepseek-harness/`) in an isolated runtime home. Managed
 * launch preparation resolves absolute process paths after certification.
 */
const DEEPSEEK_HARNESS_READONLY_PRESET: ExternalAgentPresetConfig = {
  name: "DeepSeek Harness (read-only)",
  description:
    "DeepSeek Harness with committed tool, reasoning, usage and subagent events. Native file access is read-only; Cognia tools follow the host permission policy.",
  protocol: "dsh-sdk",
  transport: "stdio",
  // Resolved at connect after the managed runtime passes certification.
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
    "DeepSeek Harness with native workspace-write authority and a shell. Cognia tools follow the host permission policy; cancelling SDK execution closes its runtime.",
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
 * The pinned current server publishes committed text, reasoning and tool
 * events, mounts MCP per session, and supports persisted resume. ACP additionally
 * carries per-tool approval and turn cancellation; SDK exposes usage and lineage.
 */
const DEEPSEEK_HARNESS_ACP_PRESET: ExternalAgentPresetConfig = {
  name: "DeepSeek Harness (interactive)",
  description:
    "DeepSeek Harness over ACP with Cognia tools, per-tool approval, turn cancellation, persisted session resume, and committed text, reasoning and tool updates.",
  protocol: "acp",
  transport: "stdio",
  // Resolved at connect through the same managed launch path as the SDK presets.
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
  "codex-acp": {
    ...buildPresetConfig("codex-acp"),
    name: "Codex (ACP)",
    description: "Run the Codex ACP adapter explicitly, without native app-server selection.",
  },
  "codex-app-server": buildPresetConfig("codex-app-server"),
  "claude-code": buildPresetConfig("claude-code"),
  "gemini-cli": buildPresetConfig("gemini-cli"),
  "cursor-cli": buildPresetConfig("cursor-cli"),
  "copilot-cli": buildPresetConfig("copilot-cli"),
  kiro: buildPresetConfig("kiro"),
  "qwen-code": buildPresetConfig("qwen-code"),
  "pi-rpc": buildPresetConfig("pi-rpc"),
  droid: buildPresetConfig("droid"),
  devin: buildPresetConfig("devin"),
  "minimax-code": buildPresetConfig("minimax-code"),
  kimi: {
    ...buildPresetConfig("kimi"),
    metadata: { acpPreviewFeatures: { sessionFork: true } },
  },
  grok: buildPresetConfig("grok"),
  cline: buildPresetConfig("cline"),
  qoder: buildPresetConfig("qoder"),
  goose: buildPresetConfig("goose"),
  aider: buildPresetConfig("aider"),
  "opencode-acp": OPENCODE_ACP_PRESET,
  "opencode-server": OPENCODE_SERVER_PRESET,
  "opencode-remote": OPENCODE_REMOTE_PRESET,
  "opencode-v2-service": OPENCODE_V2_SERVICE_PRESET,
  "deepseek-harness-readonly": DEEPSEEK_HARNESS_READONLY_PRESET,
  "deepseek-harness-workspace": DEEPSEEK_HARNESS_WORKSPACE_PRESET,
  "deepseek-harness-acp": DEEPSEEK_HARNESS_ACP_PRESET,
  custom: null,
}

// Plugin-contributed presets live in a runtime overlay the plugin contract owns,
// with every read that merges it over this static record
// (`@cognia/plugin-contract/lib/ai/agent/external/config/presets`). The record
// stays here because it is derived from the ecosystem adapters.
import {
  installBuiltinExternalAgentPresets,
  NON_EXECUTABLE_PRESET_IDS,
  type ExternalAgentPresetConfig,
  type ExternalAgentPresetId,
  type NonExecutablePresetId,
} from "@cognia/plugin-contract/lib/ai/agent/external/config/presets"
export type {
  BuiltinExternalAgentPresetCatalog,
  ExternalAgentPresetConfig,
  ExternalAgentPresetId,
  NonExecutablePresetId,
} from "@cognia/plugin-contract/lib/ai/agent/external/config/presets"
export {
  registerPreset,
  unregisterPreset,
  unregisterPresetsByPlugin,
  __resetDynamicPresetsForTesting,
  getDynamicPresetEntry,
  listDynamicPresetEntries,
  getAvailablePresets,
  getRunnablePresets,
  getPresetConfig,
  createAgentFromPreset,
  isFromPreset,
  resolvePreferredCodexExecutablePresetId,
  getPresetDisplayInfo,
} from "@cognia/plugin-contract/lib/ai/agent/external/config/presets"

installBuiltinExternalAgentPresets({
  presets: EXTERNAL_AGENT_PRESETS,
  commandExists: checkExternalAgentCommandExists,
})

/**
 * The builtin *executable* external-agent preset ids — every static preset
 * except the `custom` sentinel and runtimes without an executable process.
 * These are exactly the ids a teammate `runtime` or a subagent `externalPresetId`
 * may name; plugin-contributed presets stay outside this closed set and are
 * reached through the capability overlay instead. Derived from the record so it
 * can never drift from `EXTERNAL_AGENT_PRESETS`.
 */
export const BUILTIN_EXECUTABLE_PRESET_IDS = (
  Object.keys(EXTERNAL_AGENT_PRESETS) as ExternalAgentPresetId[]
).filter(
  (id): id is Exclude<ExternalAgentPresetId, NonExecutablePresetId> =>
    !(NON_EXECUTABLE_PRESET_IDS as readonly string[]).includes(id) &&
    EXTERNAL_AGENT_PRESETS[id] !== null
)
