// The `auto` acceptance gate (ADR-0090 Phase 5).
//
// `resolveAgentExecutionSpec()` consults this before letting `auto` bind a
// non-default execution path. Structural guarantees:
//  - only CompatibilityManifest values can even be OFFERED (connectivity
//    probes / experimental opt-ins are different types — no conversion);
//  - evidence must be native | vendor-certified | cognia-verified;
//  - the signature must verify; managed policy can require issuer cognia-ci;
//  - a stale manifest is rejected with its reasons;
//  - hard-required capabilities must be `supported`; preferred ones that are
//    not supported come back as `disabledOptional` (trace-visible), and an
//    open health circuit downgrades a capability to `unknown` (down-rank
//    only — health can never up-rank).

import type { AgentCapabilityId } from "@cognia/agent-config-types/agent-execution"
import type { CompatibilityManifest } from "@cognia/agent-config-types/compatibility-manifest"
import { compatibilityKeyId } from "@cognia/agent-config-types/compatibility-manifest"

import type { CapabilityHealthEntry } from "./certification-store"
import { computeStaleness, type CurrentVersions } from "./staleness"

export interface CompatibilityGateInput {
  manifest: CompatibilityManifest
  signatureValid: boolean
  current: CurrentVersions
  requires: AgentCapabilityId[]
  prefers: AgentCapabilityId[]
  health?: CapabilityHealthEntry[]
  managedPolicy?: { requireCiIssuer?: boolean }
  now?: Date
}

export type CompatibilityGateResult =
  | {
      accepted: true
      recordRef: string
      disabledOptional: AgentCapabilityId[]
    }
  | { accepted: false; reasons: string[] }

const AUTO_EVIDENCE: readonly string[] = ["native", "vendor-certified", "cognia-verified"]

export function evaluateCompatibilityGate(input: CompatibilityGateInput): CompatibilityGateResult {
  const reasons: string[] = []
  const { manifest } = input
  const now = input.now ?? new Date()

  if (!AUTO_EVIDENCE.includes(manifest.evidence)) {
    reasons.push(`evidence "${manifest.evidence}" is not acceptable for auto`)
  }
  if (!input.signatureValid) {
    reasons.push("manifest signature did not verify")
  }
  if (input.managedPolicy?.requireCiIssuer && manifest.issuer !== "cognia-ci") {
    reasons.push(`managed policy requires issuer cognia-ci, got ${manifest.issuer}`)
  }

  const staleness = computeStaleness(manifest, input.current, now)
  if (staleness.stale) {
    reasons.push(...staleness.reasons.map((r) => `stale: ${r}`))
  }

  const keyId = compatibilityKeyId(manifest.key)
  const openCircuits = new Set(
    (input.health ?? [])
      .filter(
        (entry) =>
          entry.keyId === keyId &&
          entry.openUntil !== undefined &&
          now.getTime() < Date.parse(entry.openUntil)
      )
      .map((entry) => entry.capability)
  )

  const supportOf = (capability: AgentCapabilityId): "supported" | "unsupported" | "unknown" => {
    if (openCircuits.has(capability)) return "unknown"
    return manifest.capabilities[capability] ?? "unknown"
  }

  for (const capability of input.requires) {
    const support = supportOf(capability)
    if (support !== "supported") {
      reasons.push(`required capability ${capability} is ${support}`)
    }
  }

  if (reasons.length > 0) return { accepted: false, reasons }

  const disabledOptional = input.prefers.filter(
    (capability) => supportOf(capability) !== "supported"
  )
  return { accepted: true, recordRef: `${manifest.bundleId}:${keyId}`, disabledOptional }
}
