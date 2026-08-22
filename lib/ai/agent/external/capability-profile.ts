/**
 * Building an `ExternalAgentCapabilityProfileV1` (ADR-0090 external SSOT).
 *
 * Two entry points, matching the two-phase admission the plan fixes:
 *
 *   1. {@link buildDeclaredCapabilityProfile} — everything knowable BEFORE the
 *      agent is contacted. Used by the static preflight, which may only refuse
 *      configurations that are already definitely wrong; a capability nothing
 *      has measured is `unknown` here, and `unknown` blocks nothing at this
 *      stage because the handshake has not had its say.
 *   2. {@link negotiateCapabilityProfile} — the same profile with the live
 *      handshake, the adapter instance's real methods and the host's facts and
 *      ceilings merged in. This is the one every consumer reads, and the one
 *      the execution spec is frozen from.
 *
 * Splitting them is the whole point: freezing a spec from step 1 is how a
 * session ends up claiming a capability the agent turned out not to have, and
 * refusing at step 1 for an `unknown` is how a working agent gets rejected
 * before it can prove itself.
 */

import {
  EXTERNAL_AGENT_CAPABILITY_IDS,
  EXTERNAL_CAPABILITY_REASON_KEYS,
  hostCeilingsCapabilityLayer,
  hostFactsCapabilityLayer,
  mergeExternalAgentCapabilities,
  type ExternalAgentCapabilityCell,
  type ExternalAgentCapabilityId,
  type ExternalAgentCapabilityLayerInput,
  type ExternalAgentCapabilityMatrix,
  type ExternalAgentCapabilityProfileV1,
  type ExternalAgentHostCeilings,
  type ExternalAgentHostFacts,
} from "@cognia/agent-config-types/external-agent-capability"

import { computeStableDigest } from "@/lib/ai/agent/execution/fingerprint"
import {
  adapterMethodCapabilityLayer,
  externalCapabilityManifestVersion,
  presetCapabilityLayer,
  protocolCapabilityLayer,
} from "./capability-manifest"
import { getPluginProtocolAdapterMetadata } from "./protocol-adapter"

/**
 * Host facts for a host that provides nothing.
 *
 * Explicit rather than defaulted at each call site: a surface that forgets to
 * describe its host must read as "Cognia adds nothing here", never as "assume
 * the desktop's facilities".
 */
export const NO_HOST_FACTS: ExternalAgentHostFacts = {
  toolHostRunning: false,
  subagentDispatchProjected: false,
  hookRuntimeAvailable: false,
}

/** A host with no clamp beyond the mandatory sandbox being available. */
export const SANDBOXED_HOST_CEILINGS: ExternalAgentHostCeilings = { sandboxAvailable: true }

export interface DeclaredCapabilityProfileInput {
  protocol: string
  presetId?: string
  /** Plugin-contributed adapter identity, when the protocol is namespaced. */
  pluginId?: string
  adapterId?: string
  adapterVersion?: string
  /**
   * A plugin adapter's own capability declaration (layer 2). Absent for a
   * plugin that predates declarations — every id then stays `unknown`, which
   * fails closed against a hard requirement while still letting the handshake
   * prove the adapter works.
   */
  pluginDeclaration?: ExternalAgentCapabilityMatrix
  hostFacts?: ExternalAgentHostFacts
  ceilings?: ExternalAgentHostCeilings
}

function fill(
  matrix: ExternalAgentCapabilityMatrix
): Record<ExternalAgentCapabilityId, ExternalAgentCapabilityCell> {
  const out = {} as Record<ExternalAgentCapabilityId, ExternalAgentCapabilityCell>
  for (const id of EXTERNAL_AGENT_CAPABILITY_IDS) {
    out[id] = matrix[id] ?? { level: "unknown", evidence: "none" }
  }
  return out
}

/**
 * The digest.
 *
 * Hashes the DECISION inputs and the merged answer, not the incidental ones:
 * `negotiated` is in it (a pre-handshake profile is not the same artifact as
 * the post-handshake one that happens to agree), `drift` is not (it is a
 * derived report about how we got here, and two hosts that reach the same
 * effective matrix by different routes describe the same capabilities).
 */
export function computeExternalAgentProfileDigest(
  profile: Omit<ExternalAgentCapabilityProfileV1, "digest">
): string {
  return computeStableDigest("eacp1", {
    profileVersion: profile.profileVersion,
    protocol: profile.protocol,
    presetId: profile.presetId,
    pluginId: profile.pluginId,
    adapterId: profile.adapterId,
    adapterVersion: profile.adapterVersion,
    manifestVersion: profile.manifestVersion,
    negotiated: profile.negotiated,
    effective: profile.effective,
  })
}

function stamp(
  profile: Omit<ExternalAgentCapabilityProfileV1, "digest">
): ExternalAgentCapabilityProfileV1 {
  return { ...profile, digest: computeExternalAgentProfileDigest(profile) }
}

/**
 * Phase 1: the static profile. No adapter instance, no handshake.
 *
 * Host facts and ceilings are still applied — they are known before connecting
 * and they can legitimately refuse a configuration outright (an unsandboxable
 * platform), which is exactly what the static preflight is for.
 */
export function buildDeclaredCapabilityProfile(
  input: DeclaredCapabilityProfileInput
): ExternalAgentCapabilityProfileV1 {
  const hostFacts = input.hostFacts ?? NO_HOST_FACTS
  const ceilings = input.ceilings ?? SANDBOXED_HOST_CEILINGS

  const protocolLayer = protocolCapabilityLayer(input.protocol)
  const refinementLayer = mergeRefinements(input)

  const declared = mergeExternalAgentCapabilities([protocolLayer, refinementLayer]).effective
  const { effective, drift } = mergeExternalAgentCapabilities([
    protocolLayer,
    refinementLayer,
    hostFactsCapabilityLayer(hostFacts),
    hostCeilingsCapabilityLayer(ceilings),
  ])

  return stamp({
    profileVersion: 1,
    protocol: input.protocol,
    ...(input.presetId ? { presetId: input.presetId } : {}),
    ...(input.pluginId ? { pluginId: input.pluginId } : {}),
    ...(input.adapterId ? { adapterId: input.adapterId } : {}),
    ...(input.adapterVersion ? { adapterVersion: input.adapterVersion } : {}),
    manifestVersion: externalCapabilityManifestVersion(),
    declared,
    live: {},
    hostFacts,
    ceilings,
    effective: fill(effective),
    drift,
    negotiated: false,
  })
}

/**
 * Layer 2 = the manifest's preset refinement, then the plugin's own
 * declaration.
 *
 * Both are `refinement`, so neither may widen what the protocol row refused —
 * a plugin author cannot declare `mcp: native` onto a protocol whose manifest
 * row says the wire has no slot for it.
 */
function mergeRefinements(
  input: DeclaredCapabilityProfileInput
): ExternalAgentCapabilityLayerInput {
  const preset = presetCapabilityLayer(input.presetId)
  if (!input.pluginDeclaration) return preset
  return {
    layer: "refinement",
    cells: { ...preset.cells, ...input.pluginDeclaration },
  }
}

export interface NegotiatedCapabilityProfileInput extends DeclaredCapabilityProfileInput {
  /**
   * The live adapter instance. Only its METHOD presence is read (layer 3) —
   * never called, so building a profile can never start work on the agent.
   */
  adapter?: Record<string, unknown>
  /** What this session's handshake actually reported (layer 4). */
  liveFacts?: ExternalAgentCapabilityMatrix
}

/**
 * Phase 2: the profile a frozen spec may be derived from.
 *
 * `negotiated` is set from whether live facts were supplied, not from whether
 * they changed anything: "the handshake happened and reported nothing new" and
 * "the handshake has not happened" are different states, and only the first one
 * may back an execution decision.
 */
export function negotiateCapabilityProfile(
  input: NegotiatedCapabilityProfileInput
): ExternalAgentCapabilityProfileV1 {
  const hostFacts = input.hostFacts ?? NO_HOST_FACTS
  const ceilings = input.ceilings ?? SANDBOXED_HOST_CEILINGS
  const live = input.liveFacts ?? {}

  const protocolLayer = protocolCapabilityLayer(input.protocol)
  const refinementLayer = mergeRefinements(input)
  const methodsLayer = adapterMethodCapabilityLayer(input.adapter)
  const hostLayer = hostFactsCapabilityLayer(hostFacts)

  const declared = mergeExternalAgentCapabilities([protocolLayer, refinementLayer]).effective
  const { effective, drift } = mergeExternalAgentCapabilities([
    protocolLayer,
    refinementLayer,
    methodsLayer,
    // Host facts and handshake facts are both `live`. Handshake facts come
    // second so an agent that explicitly refuses something the host would have
    // provided still reads as refused.
    hostLayer,
    { layer: "live", cells: live },
    hostCeilingsCapabilityLayer(ceilings),
  ])

  return stamp({
    profileVersion: 1,
    protocol: input.protocol,
    ...(input.presetId ? { presetId: input.presetId } : {}),
    ...(input.pluginId ? { pluginId: input.pluginId } : {}),
    ...(input.adapterId ? { adapterId: input.adapterId } : {}),
    ...(input.adapterVersion ? { adapterVersion: input.adapterVersion } : {}),
    manifestVersion: externalCapabilityManifestVersion(),
    declared,
    live,
    hostFacts,
    ceilings,
    effective: fill(effective),
    drift,
    negotiated: input.liveFacts !== undefined,
  })
}

/** Reason keys, re-exported so surfaces translate one vocabulary. */
export { EXTERNAL_CAPABILITY_REASON_KEYS }

/**
 * Fill the plugin half of a profile input from the adapter registry.
 *
 * Callers pass a protocol id and get back the identity and declaration that go
 * with it, without having to know whether it is built-in or contributed. A
 * built-in protocol simply adds nothing — its row is the manifest's.
 */
export function withRegisteredPluginDeclaration<T extends DeclaredCapabilityProfileInput>(
  input: T
): T {
  const metadata = getPluginProtocolAdapterMetadata(input.protocol)
  if (!metadata) return input
  return {
    ...input,
    pluginId: input.pluginId ?? metadata.pluginId,
    adapterId: input.adapterId ?? metadata.adapterId,
    ...(metadata.version && !input.adapterVersion ? { adapterVersion: metadata.version } : {}),
    ...(metadata.capabilities && !input.pluginDeclaration
      ? { pluginDeclaration: metadata.capabilities }
      : {}),
  }
}
