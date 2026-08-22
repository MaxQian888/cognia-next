/**
 * Static admission for an external agent (ADR-0090 external SSOT, phase 1).
 *
 * Runs BEFORE the process is spawned and before any handshake, and refuses only
 * what is already definitely wrong:
 *
 *   - a protocol nothing can speak (legacy `http`/`websocket`/`custom`, or a
 *     plugin protocol whose plugin is disabled or never registered);
 *   - a hard requirement the declared profile records as `unsupported`.
 *
 * What it deliberately does NOT refuse is `unknown`. Nothing has measured the
 * capability yet, and rejecting here would fail a working agent before it could
 * answer. `unknown` becomes fatal one step later, in
 * {@link admitNegotiatedExternalAgent}, once the handshake has had its say and
 * "we don't know" has hardened into "we asked and it isn't there".
 *
 * The symmetry is the point: refuse early only for what cannot change, refuse
 * late for everything that could.
 */

import type { AgentStructuredError } from "@cognia/agent-config-types/agent-run-result"
import {
  isLegacyExternalAgentProtocol,
  isPluginExternalAgentProtocol,
  isSelectableExternalAgentProtocol,
  missingExternalAgentCapabilities,
  type ExternalAgentCapabilityId,
  type ExternalAgentCapabilityProfileV1,
  type ExternalAgentHostCeilings,
  type ExternalAgentHostFacts,
} from "@cognia/agent-config-types/external-agent-capability"

import {
  buildDeclaredCapabilityProfile,
  withRegisteredPluginDeclaration,
} from "./capability-profile"
import { protocolAdapterRegistry } from "./protocol-adapter"

export interface ExternalAgentPreflightInput {
  protocol: string
  presetId?: string
  /** Hard requirements for the run. A declared `unsupported` refuses here. */
  requires?: readonly ExternalAgentCapabilityId[]
  hostFacts?: ExternalAgentHostFacts
  ceilings?: ExternalAgentHostCeilings
  /** Injected for tests; defaults to the live protocol-adapter registry. */
  hasAdapter?: (protocol: string) => boolean
}

export type ExternalAgentPreflight =
  | { ok: true; profile: ExternalAgentCapabilityProfileV1 }
  | { ok: false; error: AgentStructuredError; profile: ExternalAgentCapabilityProfileV1 }

/**
 * The `AgentErrorCode` for "the adapter this configuration needs is not
 * loaded". `config_error` rather than `runtime_error`: the fix is to enable the
 * plugin or pick a different protocol, not to retry.
 */
const ADAPTER_UNAVAILABLE = "config_error" as const

export function preflightExternalAgent(input: ExternalAgentPreflightInput): ExternalAgentPreflight {
  const hasAdapter =
    input.hasAdapter ?? ((protocol: string) => protocolAdapterRegistry.has(protocol))

  const profile = buildDeclaredCapabilityProfile(
    withRegisteredPluginDeclaration({
      protocol: input.protocol,
      ...(input.presetId ? { presetId: input.presetId } : {}),
      ...(input.hostFacts ? { hostFacts: input.hostFacts } : {}),
      ...(input.ceilings ? { ceilings: input.ceilings } : {}),
    })
  )

  if (!isSelectableExternalAgentProtocol(input.protocol)) {
    return {
      ok: false,
      profile,
      error: {
        code: ADAPTER_UNAVAILABLE,
        message: isLegacyExternalAgentProtocol(input.protocol)
          ? `external-agent protocol "${input.protocol}" has no adapter and has never been runnable; ` +
            `the configuration can be read and migrated, but not started`
          : `"${input.protocol}" is not a valid external-agent protocol`,
        detail: { protocol: input.protocol, reason: "adapter_unavailable" },
      },
    }
  }

  if (!hasAdapter(input.protocol)) {
    const plugin = isPluginExternalAgentProtocol(input.protocol)
    return {
      ok: false,
      profile,
      error: {
        code: ADAPTER_UNAVAILABLE,
        message: plugin
          ? `the plugin that contributes protocol "${input.protocol}" is not enabled`
          : `no adapter is registered for protocol "${input.protocol}"`,
        detail: { protocol: input.protocol, reason: "adapter_unavailable", plugin },
      },
    }
  }

  // Only a DECLARED refusal blocks here. `unknown` is deliberately admitted —
  // see the module header.
  const requires = input.requires ?? []
  const refused = missingExternalAgentCapabilities(profile, requires).filter(
    ({ cell }) => cell.level === "unsupported"
  )
  if (refused.length > 0) {
    return {
      ok: false,
      profile,
      error: capabilityError(input.protocol, refused, input.presetId),
    }
  }

  return { ok: true, profile }
}

export interface NegotiatedAdmissionInput {
  profile: ExternalAgentCapabilityProfileV1
  requires?: readonly ExternalAgentCapabilityId[]
}

/**
 * Phase 2 admission: the profile has been negotiated, so `unknown` is now fatal.
 *
 * Refusing an un-negotiated profile outright is not pedantry — a spec frozen
 * from a pre-handshake profile is a promise nobody checked, and the whole
 * two-phase split exists so that promise is never made.
 */
export function admitNegotiatedExternalAgent(
  input: NegotiatedAdmissionInput
): { ok: true } | { ok: false; error: AgentStructuredError } {
  const { profile } = input
  if (!profile.negotiated) {
    return {
      ok: false,
      error: {
        code: "runtime_error",
        message:
          `the capability profile for "${profile.protocol}" was never negotiated; ` +
          `an execution spec must not be frozen before the handshake`,
        detail: { protocol: profile.protocol, reason: "profile_not_negotiated" },
      },
    }
  }

  const missing = missingExternalAgentCapabilities(profile, input.requires ?? [])
  if (missing.length === 0) return { ok: true }
  return { ok: false, error: capabilityError(profile.protocol, missing, profile.presetId) }
}

function capabilityError(
  protocol: string,
  missing: ReturnType<typeof missingExternalAgentCapabilities>,
  presetId: string | undefined
): AgentStructuredError {
  const first = missing[0]
  return {
    code: "unsupported_capability",
    message:
      `external agent${presetId ? ` "${presetId}"` : ""} on protocol "${protocol}" cannot provide ` +
      missing.map(({ capability, cell }) => `${capability} (${cell.level})`).join(", "),
    // `capability` is typed as the CLOSED v2 id. An external-only id has no v2
    // name, so it is reported in `detail` rather than smuggled into a field
    // whose type says it cannot hold it.
    ...(isSpecCapability(first.capability) ? { capability: first.capability } : {}),
    detail: {
      protocol,
      ...(presetId ? { presetId } : {}),
      missing: missing.map(({ capability, cell }) => ({
        capability,
        level: cell.level,
        evidence: cell.evidence,
        ...(cell.reasonKey ? { reasonKey: cell.reasonKey } : {}),
      })),
    },
  }
}

function isSpecCapability(
  id: ExternalAgentCapabilityId
): id is Exclude<
  ExternalAgentCapabilityId,
  "mcp.logs" | "rate-limit-reporting" | "subagents.model-selection" | "models.list"
> {
  return (
    id !== "mcp.logs" &&
    id !== "rate-limit-reporting" &&
    id !== "subagents.model-selection" &&
    id !== "models.list"
  )
}
