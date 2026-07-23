import {
  compatibilityKeyId,
  manifestSigningPayload,
  validateCompatibilityManifest,
} from "./compatibility-manifest"
import type { CompatibilityManifest } from "./compatibility-manifest"

const valid: CompatibilityManifest = {
  manifestVersion: 1,
  bundleId: "bundle-a",
  key: {
    runtime: "claude-agent-sdk",
    ingressProtocol: "anthropic",
    routeMode: "gateway",
    translationMode: "passthrough",
    deploymentRef: "dep-1",
    model: "claude-opus-4-8",
    agentSdkVersion: "0.3.183",
    claudeCodeVersion: "2.1.0",
    gatewayVersion: "0.1.0",
    suiteVersion: "1",
  },
  evidence: "cognia-verified",
  level: "core",
  capabilities: { streaming: "supported" },
  suiteResults: [{ caseId: "text-sse", passed: true }],
  parity: { passed: true },
  knownLosses: [],
  issuer: "cognia-ci",
  issuedAt: "2026-07-23T00:00:00.000Z",
}

describe("validateCompatibilityManifest", () => {
  it("accepts a fully-formed manifest", () => {
    expect(validateCompatibilityManifest(valid).ok).toBe(true)
  })

  it("rejects missing key axes, unknown capabilities, and bad enums", () => {
    const noAxis = validateCompatibilityManifest({
      ...valid,
      key: { ...valid.key, suiteVersion: "" },
    })
    expect(noAxis.ok).toBe(false)

    const badCap = validateCompatibilityManifest({
      ...valid,
      capabilities: { telepathy: "supported" },
    })
    expect(badCap.ok).toBe(false)

    expect(validateCompatibilityManifest({ ...valid, evidence: "trusted" }).ok).toBe(false)
    expect(validateCompatibilityManifest({ ...valid, issuer: "somebody" }).ok).toBe(false)
    expect(validateCompatibilityManifest(null).ok).toBe(false)
  })
})

describe("manifestSigningPayload", () => {
  it("is key-order independent and excludes the signature", () => {
    const signed = { ...valid, signature: "AAAA" }
    expect(manifestSigningPayload(signed)).toBe(manifestSigningPayload(valid))
    const reordered = JSON.parse(JSON.stringify(valid)) as CompatibilityManifest
    expect(manifestSigningPayload(reordered)).toBe(manifestSigningPayload(valid))
  })
})

describe("compatibilityKeyId", () => {
  it("joins every axis in stable order", () => {
    expect(compatibilityKeyId(valid.key)).toBe(
      "claude-agent-sdk|anthropic|gateway|passthrough|dep-1|claude-opus-4-8|0.3.183|2.1.0|0.1.0|1"
    )
  })
})
