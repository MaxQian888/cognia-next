import { PINNED_RUNTIME_VERSIONS } from "@cognia/agent-config-types/runtime-versions"
import type { CompatibilityManifest } from "@cognia/agent-config-types/compatibility-manifest"

import { computeStaleness, currentVersions, type CurrentVersions } from "./staleness"

function manifestWith(key: Partial<CompatibilityManifest["key"]>): CompatibilityManifest {
  return {
    manifestVersion: 1,
    bundleId: "bundle-1",
    key: {
      runtime: "claude-agent-sdk",
      ingressProtocol: "anthropic",
      routeMode: "gateway",
      translationMode: "passthrough",
      deploymentRef: "dep-1",
      model: "model-alpha",
      agentSdkVersion: "1.0.0",
      claudeCodeVersion: "2.0.0",
      gatewayVersion: "0.1.0",
      suiteVersion: "suite-1",
      ...key,
    },
    evidence: "cognia-verified",
    level: "core",
    capabilities: {},
    suiteResults: [],
    parity: { passed: true },
    knownLosses: [],
    issuer: "cognia-ci",
    issuedAt: "2026-07-23T00:00:00.000Z",
  } as CompatibilityManifest
}

const current: CurrentVersions = {
  agentSdkVersion: "1.0.0",
  gatewayVersion: "0.1.0",
  claudeCodeVersion: "2.0.0",
  suiteVersion: "suite-1",
}

describe("currentVersions", () => {
  it("pins SDK/gateway from PINNED_RUNTIME_VERSIONS and takes host truth from the caller", () => {
    const v = currentVersions({ claudeCodeVersion: "2.1.0", suiteVersion: "suite-9" })
    expect(v).toEqual({
      agentSdkVersion: PINNED_RUNTIME_VERSIONS.agentSdkVersion,
      gatewayVersion: PINNED_RUNTIME_VERSIONS.gatewayCrateVersion,
      claudeCodeVersion: "2.1.0",
      suiteVersion: "suite-9",
    })
  })
})

describe("computeStaleness", () => {
  it("is fresh when every certified axis matches the installed versions", () => {
    expect(computeStaleness(manifestWith({}), current)).toEqual({ stale: false, reasons: [] })
  })

  it("goes stale on ANY single version-axis drift, naming the axis", () => {
    for (const [axis, drift] of [
      ["agentSdkVersion", { agentSdkVersion: "9.9.9" }],
      ["gatewayVersion", { gatewayVersion: "9.9.9" }],
      ["claudeCodeVersion", { claudeCodeVersion: "9.9.9" }],
      ["suiteVersion", { suiteVersion: "suite-9" }],
    ] as const) {
      const verdict = computeStaleness(manifestWith(drift), current)
      expect(verdict.stale).toBe(true)
      expect(verdict.reasons).toHaveLength(1)
      expect(verdict.reasons[0]).toContain(axis)
    }
  })

  it("accumulates one reason per drifted axis", () => {
    const verdict = computeStaleness(
      manifestWith({ agentSdkVersion: "9.9.9", suiteVersion: "suite-9" }),
      current
    )
    expect(verdict.stale).toBe(true)
    expect(verdict.reasons).toHaveLength(2)
  })

  it("expires at (and after) expiresAt but not before", () => {
    const manifest = { ...manifestWith({}), expiresAt: "2026-08-01T00:00:00.000Z" }
    expect(computeStaleness(manifest, current, new Date("2026-07-31T23:59:59Z")).stale).toBe(false)
    const at = computeStaleness(manifest, current, new Date("2026-08-01T00:00:00Z"))
    expect(at.stale).toBe(true)
    expect(at.reasons[0]).toContain("expired")
  })
})
