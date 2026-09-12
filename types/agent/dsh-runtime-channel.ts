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
 * Cognia supports the current session format 3 wire only; historical format
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
 * Confirmed against published 0.1.5-rc.1 SDK protocol/server and session format
 * 3 declarations. Only durable message settlements cross the current SDK wire.
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
