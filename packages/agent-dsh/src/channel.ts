import { z } from "zod"

/**
 * Certification and capability contract for a Cognia-owned DeepSeek Harness
 * (DSH) runtime installation.
 *
 * A channel pins the current upstream dsh executable and its protocol packages,
 * together with Cognia's certified host composition and launcher. The package
 * lock and composition digests identify the exact runtime we can execute.
 *
 * @see runtime/deepseek-harness/README.md for why Cognia owns the host plane.
 */

/**
 * The transports Cognia drives a DSH runtime over.
 *
 * These are not interchangeable and a session may never move between them:
 * both publish committed tool/reasoning events, while `dsh-sdk` cannot
 * ask for approval or cancel a single turn. Switching would silently change
 * both what the user can see and what they can veto.
 */
export const DSH_TRANSPORTS = ["dsh-sdk", "acp"] as const
export type DshTransport = (typeof DSH_TRANSPORTS)[number]

/**
 * The certified host compositions Cognia ships.
 *
 * `cognia-sdk-readonly` is the default. Its native file read-only guarantee does not come
 * from the sandbox mode alone — DSH lets a model retry a denied call with
 * `sandbox_permissions: "workspace-write"`, and that escalation only fails
 * closed because the profile composes no `ctx.approval` provider.
 */
export const DSH_PROFILE_IDS = [
  "cognia-sdk-readonly",
  "cognia-sdk-workspace",
  "cognia-acp",
] as const
export type DshProfileId = (typeof DSH_PROFILE_IDS)[number]

export const DSH_PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"] as const
export type DshPlatform = (typeof DSH_PLATFORMS)[number]

/**
 * What a given transport + profile can actually do.
 *
 * Every field here is a statement of fact about upstream, not an aspiration.
 * It exists because `RUNTIME_CAPABILITIES.external` in the execution resolver
 * grants capabilities across multiple protocols. Current DSH ACP supports
 * persisted resume and model configuration; SDK control remains launch-scoped.
 * Resolved specs intersect the static table with this snapshot so
 * the compatibility gate cannot pass capabilities the runtime lacks, and the UI
 * cannot render controls that do nothing.
 */
export const dshCapabilitySnapshotSchema = z.object({
  transport: z.enum(DSH_TRANSPORTS),

  /** Live token deltas. Current SDK and ACP publish committed messages only. */
  streamingDeltas: z.boolean(),
  /** Per-tool call/result events settled on the wire. */
  toolEvents: z.boolean(),
  /** Committed model reasoning content. */
  reasoning: z.boolean(),
  /** Token accounting. SDK reports it on committed `assistant/message` records. */
  usage: z.boolean(),
  /** Parent/child agent lineage via `subagent.started` / `subagent.finished`. */
  subagentLineage: z.boolean(),

  /** Mid-turn approval requests routed to the user. SDK wire has no such path. */
  interactiveApproval: z.boolean(),
  /** Cancelling one turn while keeping the runtime. SDK must close the process. */
  turnCancellation: z.boolean(),
  /** Passing Cognia servers through native ACP or isolated SDK startup mounting. */
  mcpPassthrough: z.boolean(),
  /** Reattaching to an earlier persisted session. */
  sessionResume: z.boolean(),
})
export type DshCapabilitySnapshot = z.infer<typeof dshCapabilitySnapshotSchema>

export const dshProfileDescriptorSchema = z.object({
  profileId: z.enum(DSH_PROFILE_IDS),
  /** Composition filename inside the runtime home, e.g. `host.sdk-readonly.yml`. */
  compositionFile: z.string().min(1),
  capabilities: dshCapabilitySnapshotSchema,
  /**
   * Whether this profile composes a subprocess/PTY provider.
   *
   * `node-pty` is a static top-level import with no Linux prebuild upstream, so
   * a profile that needs it requires a node-gyp toolchain on Linux. `doctor`
   * reads this to decide whether to check for one.
   */
  requiresNativeSubprocess: z.boolean(),
})
export type DshProfileDescriptor = z.infer<typeof dshProfileDescriptorSchema>

/**
 * A certified, installed runtime.
 *
 * The pinned dependency and composition digests identify the certified build.
 * Cognia supports the current session format 4 wire only; historical format
 * migrations belong to upstream storage and are not SDK compatibility paths.
 */
export const dshRuntimeChannelSchema = z.object({
  schemaVersion: z.literal(1),
  channelId: z.string().min(1),

  /** sha256 of the pinned lockfile. The authoritative dependency identity. */
  lockfileDigest: z.string().regex(/^[0-9a-f]{64}$/),
  /** sha256 over the host compositions and the launcher, in a stable order. */
  compositionDigest: z.string().regex(/^[0-9a-f]{64}$/),

  /** Upstream version this channel pins, for display and diagnostics only. */
  upstreamVersion: z.string().min(1),
  /**
   * Major Node version the runtime requires.
   *
   * The published packages carry no `engines` field, so this cannot be read
   * from package metadata; upstream documents 22.19+/24+/26 in its development
   * guide. Cognia's bundled Node is 26.x, which satisfies it.
   */
  nodeMajorRequired: z.union([z.literal(22), z.literal(24), z.literal(26)]),
  platforms: z.array(z.enum(DSH_PLATFORMS)).min(1),
  profiles: z.array(dshProfileDescriptorSchema).min(1),

  /** Version of the DSH conformance suite this channel was certified against. */
  conformanceSuiteVersion: z.string().min(1),

  /** Always true while upstream is a developer preview. */
  experimental: z.literal(true),
})
export type DshRuntimeChannel = z.infer<typeof dshRuntimeChannelSchema>

/**
 * Capability facts for the SDK transport.
 *
 * Confirmed against published 0.2.1-rc.2 SDK protocol/server and session format
 * 4 declarations. Only durable message settlements cross the current SDK wire.
 */
export const DSH_SDK_CAPABILITIES: DshCapabilitySnapshot = {
  transport: "dsh-sdk",
  streamingDeltas: false,
  toolEvents: true,
  reasoning: true,
  usage: true,
  subagentLineage: true,
  // "Server->client requests are dead capability -- the transport supports them,
  // but the server never sends one." (dsh-sdk-protocol)
  interactiveApproval: false,
  // "No mid-turn cancel -- the wire has no prompt-cancel method; abandoning a
  // turn means closing the runtime." (dsh-sdk-client)
  turnCancellation: false,
  mcpPassthrough: true,
  // Upstream now supports session/resume; Cognia's SDK adapter does not yet expose it.
  sessionResume: false,
}

/** Current ACP server publishes committed tool/reasoning updates, mounts MCP
 * clients per session, and advertises list/resume/close plus model config options.
 */
export const DSH_ACP_CAPABILITIES: DshCapabilitySnapshot = {
  transport: "acp",
  streamingDeltas: false,
  toolEvents: true,
  reasoning: true,
  usage: false,
  subagentLineage: false,
  interactiveApproval: true,
  turnCancellation: true,
  mcpPassthrough: true,
  sessionResume: true,
}

export function dshCapabilitiesForTransport(transport: DshTransport): DshCapabilitySnapshot {
  return transport === "dsh-sdk" ? DSH_SDK_CAPABILITIES : DSH_ACP_CAPABILITIES
}

/**
 * Whether the native DSH file tools refuse mutations.
 * Cognia MCP tools independently follow the host broker permission policy.
 *
 * Read-only is a property of the whole composition, not of the sandbox mode:
 * the model can request escalation to `workspace-write`, and the request is
 * only refused because no approval provider is composed. Callers that gate on
 * "is this safe to run unattended" must ask this, not inspect the mode.
 */
export function isReadOnlyProfile(profileId: DshProfileId): boolean {
  return profileId === "cognia-sdk-readonly"
}

export function profileTransport(profileId: DshProfileId): DshTransport {
  return profileId === "cognia-acp" ? "acp" : "dsh-sdk"
}

export type DshPluginStatus = "enabled" | "disabled" | "conditional" | "not-composed"
export type DshPluginCondition =
  "direct-provider" | "cognia-gateway" | "mcp-servers" | "windows-only"

/** Certified composition, not a report of installed packages or a live session. */
export interface DshProfilePlugin {
  id: string
  packageName: string
  status: DshPluginStatus
  condition?: DshPluginCondition
}

// Exact rows from the pinned sdk-minimal bundle and Cognia overlays. Keeping IDs
// preserves two differently configured instances of the same upstream package.
const COMMON_PROFILE_PLUGINS = {
  "deepseek-llm-api-extensions": "dsh-deepseek-llm-api-extensions",
  "session-log-deepseek": "dsh-session-log-deepseek",
  "plugin-package-inventory-deepseek": "dsh-plugin-package-inventory-deepseek",
  sandbox: "dsh-sandbox-local",
  "attachment-local": "dsh-attachment-local",
  "tool-fs": "dsh-tool-fs",
  "working-directory": "dsh-working-directory",
  "tool-working-directory": "dsh-tool-working-directory",
  "session-projection": "dsh-session-projection",
  "token-meter": "dsh-token-meter",
  "compaction-basic": "dsh-compaction-basic",
  "image-offload": "dsh-compaction-image-offload",
  "sandbox-policy": "dsh-sandbox-policy",
  timer: "cordis-plugin-timer",
  llm: "dsh-llm",
  session: "dsh-session",
  "session-title": "dsh-session-title",
  "system-prompt": "dsh-system-prompt",
  tools: "dsh-tools",
  "mcp-resources": "dsh-mcp-resources",
  agent: "dsh-agent",
  "llm-retry": "dsh-llm-retry",
  "agent-loop": "dsh-agent-loop",
  sessions: "dsh-session-persistence-jsonl",
  "fs-sandboxed": "dsh-fs-sandbox",
} as const

const SHELL_PROFILE_PLUGINS = {
  subprocess: "dsh-subprocess-local",
  pty: "dsh-terminal",
  "terminal-bash": "dsh-terminal-bash",
  "persistent-bash": "dsh-tool-bash-persistent",
  jobs: "dsh-jobs-local",
} as const

const OPTIONAL_PROFILE_PLUGINS = {
  "agent-instructions": "dsh-agent-instructions",
  "plugin-manager": "dsh-plugin-manager",
  "tool-plugin-manager": "dsh-plugin-manager/tools",
  "client-ui-plugin-manager": "dsh-client-ui-plugin-manager",
  subagent: "dsh-subagent",
  "subagent-fork": "dsh-subagent-fork-in-process",
  "subagent-spawn": "dsh-subagent-spawn-in-process",
  "tool-subagent": "dsh-tool-subagent",
  "tool-subagent-control": "dsh-tool-subagent-control",
  skill: "dsh-skill",
  "skill-filesystem": "dsh-skill-filesystem",
  "tool-skill": "dsh-tool-skill",
  "tool-fs-search": "dsh-tool-fs-search",
  "web-search": "dsh-web-search-deepseek",
  "tool-todo": "dsh-tool-todo",
  goal: "dsh-goal",
  "goal-round-driver": "dsh-goal-round-driver",
  "tool-goal": "dsh-tool-goal",
  "ptc-runtime": "dsh-ptc-runtime",
  "ptc-runtime-node": "dsh-ptc-runtime-node",
  "workflow-ptc": "dsh-workflow-ptc",
} as const

/** All three profiles are certified only on macOS/Linux; PowerShell stays disabled. */
export function dshPluginsForProfile(profileId: DshProfileId): readonly DshProfilePlugin[] {
  const acp = profileId === "cognia-acp"
  const workspace = profileId === "cognia-sdk-workspace"
  const rows = (
    plugins: Readonly<Record<string, string>>,
    status: DshPluginStatus
  ): DshProfilePlugin[] =>
    Object.entries(plugins).map(([id, name]) => ({
      id,
      packageName: `@deepseek-ai/${name}`,
      status,
    }))
  return [
    ...rows(COMMON_PROFILE_PLUGINS, "enabled"),
    ...rows(SHELL_PROFILE_PLUGINS, workspace ? "enabled" : "disabled"),
    ...rows(OPTIONAL_PROFILE_PLUGINS, "not-composed"),
    ...rows(
      { "sdk-app-startup": "dsh-sdk-app", "sdk-jsonrpc-server": "dsh-sdk-jsonrpc-server" },
      acp ? "disabled" : "enabled"
    ),
    ...rows(
      { "acp-app-startup": "dsh-acp-app", acp: "dsh-acp", "user-approval": "dsh-user-approval" },
      acp ? "enabled" : "not-composed"
    ),
    { id: "cognia-services", packageName: "./launcher.mjs", status: "enabled" },
    { id: "filesystem", packageName: "@deepseek-ai/dsh-fs-local", status: "disabled" },
    {
      id: "terminal-pwsh",
      packageName: "@deepseek-ai/dsh-terminal-bash",
      status: "disabled",
      condition: "windows-only",
    },
    {
      id: "persistent-pwsh",
      packageName: "@deepseek-ai/dsh-tool-pwsh-persistent",
      status: "disabled",
      condition: "windows-only",
    },
    {
      id: "llm-deepseek",
      packageName: "@deepseek-ai/dsh-llm-deepseek-api-key",
      status: "conditional",
      condition: "direct-provider",
    },
    {
      id: "llm-pi-ai",
      packageName: "@deepseek-ai/dsh-llm-pi-ai",
      status: "conditional",
      condition: "cognia-gateway",
    },
    {
      id: "mcp-client",
      packageName: "@deepseek-ai/dsh-mcp-client",
      status: "conditional",
      condition: "mcp-servers",
    },
  ]
}

/** Native composition capabilities; governed Cognia/MCP tools have their own policy. */
export function dshNativeCapabilitiesForProfile(profileId: DshProfileId) {
  const workspace = profileId === "cognia-sdk-workspace"
  return {
    fileRead: true,
    fileWrite: !isReadOnlyProfile(profileId),
    persistentShell: workspace,
    jobsBackend: workspace,
    // A jobs service does not compose native background-task management tools.
    jobsManagement: false,
    subagents: false,
    skills: false,
    autoCompaction: true,
    sessionResume: dshCapabilitiesForTransport(profileTransport(profileId)).sessionResume,
  }
}
