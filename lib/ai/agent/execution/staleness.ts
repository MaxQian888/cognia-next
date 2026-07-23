// Certification staleness (ADR-0090 Phase 5).
//
// A manifest is stale for `auto` the moment ANY version axis it certified no
// longer matches what is installed/deployed. Current pins come from
// `runtime-versions.ts` (gated against the real sources by
// check-runtime-versions.mjs) plus the caller-supplied deployment/profile and
// suite versions.

import type { CompatibilityManifest } from "@cognia/agent-config-types/compatibility-manifest"
import { PINNED_RUNTIME_VERSIONS } from "@cognia/agent-config-types/runtime-versions"

export interface CurrentVersions {
  agentSdkVersion: string
  gatewayVersion: string
  /** The embedded claude-code version the sidecar reported at boot. */
  claudeCodeVersion: string
  suiteVersion: string
}

export function currentVersions(input: {
  claudeCodeVersion: string
  suiteVersion: string
}): CurrentVersions {
  return {
    agentSdkVersion: PINNED_RUNTIME_VERSIONS.agentSdkVersion,
    gatewayVersion: PINNED_RUNTIME_VERSIONS.gatewayCrateVersion,
    claudeCodeVersion: input.claudeCodeVersion,
    suiteVersion: input.suiteVersion,
  }
}

export interface StalenessVerdict {
  stale: boolean
  reasons: string[]
}

export function computeStaleness(
  manifest: CompatibilityManifest,
  current: CurrentVersions,
  now: Date = new Date()
): StalenessVerdict {
  const reasons: string[] = []
  const axes: Array<[string, string, string]> = [
    ["agentSdkVersion", manifest.key.agentSdkVersion, current.agentSdkVersion],
    ["gatewayVersion", manifest.key.gatewayVersion, current.gatewayVersion],
    ["claudeCodeVersion", manifest.key.claudeCodeVersion, current.claudeCodeVersion],
    ["suiteVersion", manifest.key.suiteVersion, current.suiteVersion],
  ]
  for (const [axis, certified, actual] of axes) {
    if (certified !== actual) {
      reasons.push(`${axis}: certified ${certified}, current ${actual}`)
    }
  }
  if (manifest.expiresAt && now.getTime() >= Date.parse(manifest.expiresAt)) {
    reasons.push(`expired at ${manifest.expiresAt}`)
  }
  return { stale: reasons.length > 0, reasons }
}
