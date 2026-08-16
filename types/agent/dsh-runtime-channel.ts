import { z } from "zod"

/**
 * Certification and capability contract for a Cognia-owned DeepSeek Harness
 * (DSH) runtime installation.
 *
 * DSH ships no executable for either transport Cognia integrates against, so a
 * "channel" is not an upstream artifact Cognia points at. It is the triple
 * Cognia itself owns and versions: a pinned dependency lockfile, a host-plane
 * Cordis composition, and the launcher that boots it (`runtime/deepseek-harness/`).
 *
 * @see runtime/deepseek-harness/README.md for why Cognia owns the host plane.
 */

/**
 * The transports Cognia drives a DSH runtime over.
 *
 * These are not interchangeable and a session may never move between them:
 * `acp` cannot report tool activity or reasoning at all, and `dsh-sdk` cannot
 * ask for approval or cancel a single turn. Switching would silently change
 * both what the user can see and what they can veto.
 */
export const DSH_TRANSPORTS = ["dsh-sdk", "acp"] as const
export type DshTransport = (typeof DSH_TRANSPORTS)[number]

/**
 * The certified host compositions Cognia ships.
 *
 * `cognia-sdk-readonly` is the default. Its read-only guarantee does not come
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
 * grants the external adapter `session.resume`, `steer`, `set-model`, and
 * `permissions.interrupt-resume` — DSH supports none of those on either
 * transport. Resolved specs intersect the static table with this snapshot so
 * the compatibility gate cannot pass capabilities the runtime lacks, and the UI
 * cannot render controls that do nothing.
 */
export const dshCapabilitySnapshotSchema = z.object({
  transport: z.enum(DSH_TRANSPORTS),

  /** Streaming deltas. ACP emits committed messages only. */
  streamingDeltas: z.boolean(),
  /** Per-tool call/result events. ACP keeps tool activity off the wire entirely. */
  toolEvents: z.boolean(),
  /** Model reasoning content. ACP: none. */
  reasoning: z.boolean(),
  /** Token accounting. SDK reports it per step on an `assistant/chunk`. */
  usage: z.boolean(),
  /** Parent/child agent lineage via `subagent.started` / `subagent.finished`. */
  subagentLineage: z.boolean(),

  /** Mid-turn approval requests routed to the user. SDK wire has no such path. */
  interactiveApproval: z.boolean(),
  /** Cancelling one turn while keeping the runtime. SDK must close the process. */
  turnCancellation: z.boolean(),
  /** Passing Cognia's MCP servers through. ACP rejects a non-empty `mcpServers`. */
  mcpPassthrough: z.boolean(),
  /** Reattaching to an earlier session. Neither transport supports it. */
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
 * Identity is the three digests, not a version string. DSH published six release
 * candidates in three days, its README warns of compatibility-breaking changes,
 * and `SESSION_FORMAT_VERSION` is `0` with no compatibility promise — so semver
 * carries no compatibility signal and is recorded for display only.
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
 * Confirmed against a live run of `runtime/deepseek-harness/host.sdk-readonly.yml`
 * and against upstream's own recorded notification snapshots.
 */
export const DSH_SDK_CAPABILITIES: DshCapabilitySnapshot = {
  transport: "dsh-sdk",
  streamingDeltas: true,
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

/**
 * Capability facts for the ACP transport.
 *
 * `@deepseek-ai/dsh-acp` describes itself as an "Automation-only" server:
 * "Committed answers only -- live progress, reasoning, tool activity, plans,
 * titles, and usage stay off the wire." Everything observable is therefore
 * false, which is why this transport is not Cognia's default.
 */
export const DSH_ACP_CAPABILITIES: DshCapabilitySnapshot = {
  transport: "acp",
  streamingDeltas: false,
  toolEvents: false,
  reasoning: false,
  usage: false,
  subagentLineage: false,
  // One-shot allow/reject only; there is no allow-always option.
  interactiveApproval: true,
  turnCancellation: true,
  // "empty additionalDirectories and mcpServers are accepted, non-empty values reject"
  mcpPassthrough: false,
  // "Fresh sessions only -- load, list, resume, delete, and fork are unsupported."
  sessionResume: false,
}

export function dshCapabilitiesForTransport(transport: DshTransport): DshCapabilitySnapshot {
  return transport === "dsh-sdk" ? DSH_SDK_CAPABILITIES : DSH_ACP_CAPABILITIES
}

/**
 * Whether a profile can be trusted to refuse mutations.
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
