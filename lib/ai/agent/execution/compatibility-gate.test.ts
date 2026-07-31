import type { CompatibilityManifest } from "@cognia/agent-config-types/compatibility-manifest"
import { validateCompatibilityManifest } from "@cognia/agent-config-types/compatibility-manifest"

import {
  CIRCUIT_OPEN_THRESHOLD,
  isCircuitOpen,
  recordCapabilityFailure,
  recordCapabilitySuccess,
} from "./capability-health"
import { evaluateCompatibilityGate } from "./compatibility-gate"
import { computeStaleness } from "./staleness"

const current = {
  agentSdkVersion: "0.3.183",
  gatewayVersion: "0.1.0",
  claudeCodeVersion: "2.1.0",
  suiteVersion: "1",
}

function manifest(overrides: Partial<CompatibilityManifest> = {}): CompatibilityManifest {
  return {
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
    capabilities: {
      streaming: "supported",
      "tools.ordinary": "supported",
      "prompt-caching": "unsupported",
    },
    suiteResults: [{ caseId: "text-sse", passed: true }],
    parity: { passed: true },
    knownLosses: [],
    issuer: "cognia-ci",
    issuedAt: "2026-07-23T00:00:00.000Z",
    ...overrides,
  }
}

const base = {
  manifest: manifest(),
  signatureValid: true,
  current,
  requires: ["streaming" as const],
  prefers: [],
}

describe("evaluateCompatibilityGate", () => {
  it("accepts a valid, signed, fresh cognia-verified manifest", () => {
    const result = evaluateCompatibilityGate(base)
    expect(result).toMatchObject({ accepted: true })
    if (result.accepted) expect(result.recordRef).toContain("bundle-a:")
  })

  it("rejects experimental/unsupported evidence — probes structurally cannot enter", () => {
    for (const evidence of ["experimental", "unsupported"] as const) {
      const result = evaluateCompatibilityGate({ ...base, manifest: manifest({ evidence }) })
      expect(result.accepted).toBe(false)
    }
    // A connectivity-probe-shaped object is not even a valid manifest.
    expect(validateCompatibilityManifest({ ok: true, latencyMs: 40 }).ok).toBe(false)
  })

  it("rejects unverified signatures and non-CI issuers under managed policy", () => {
    expect(evaluateCompatibilityGate({ ...base, signatureValid: false }).accepted).toBe(false)
    const local = evaluateCompatibilityGate({
      ...base,
      manifest: manifest({ issuer: "local" }),
      managedPolicy: { requireCiIssuer: true },
    })
    expect(local.accepted).toBe(false)
  })

  it("rejects stale manifests on every version axis and on expiry", () => {
    for (const axis of [
      { agentSdkVersion: "0.4.0" },
      { gatewayVersion: "0.2.0" },
      { claudeCodeVersion: "3.0.0" },
      { suiteVersion: "2" },
    ]) {
      const stale = evaluateCompatibilityGate({ ...base, current: { ...current, ...axis } })
      expect(stale.accepted).toBe(false)
      if (!stale.accepted) expect(stale.reasons.join(" ")).toContain("stale")
    }
    const expired = evaluateCompatibilityGate({
      ...base,
      manifest: manifest({ expiresAt: "2026-01-01T00:00:00.000Z" }),
      now: new Date("2026-07-23T00:00:00.000Z"),
    })
    expect(expired.accepted).toBe(false)
  })

  it("required-unsupported rejects; preferred-unsupported disables with trace", () => {
    const rejected = evaluateCompatibilityGate({
      ...base,
      requires: ["streaming", "prompt-caching"],
    })
    expect(rejected.accepted).toBe(false)
    if (!rejected.accepted) {
      expect(rejected.reasons.join(" ")).toContain("prompt-caching")
    }

    const preferred = evaluateCompatibilityGate({
      ...base,
      prefers: ["prompt-caching", "tools.ordinary"],
    })
    expect(preferred).toMatchObject({ accepted: true, disabledOptional: ["prompt-caching"] })
  })

  it("an open health circuit downgrades a capability to unknown (down-rank only)", () => {
    const keyId =
      "claude-agent-sdk|anthropic|gateway|passthrough|dep-1|claude-opus-4-8|0.3.183|2.1.0|0.1.0|1"
    const health = [
      {
        keyId,
        capability: "streaming",
        consecutiveFailures: 3,
        openUntil: "2026-07-23T01:00:00.000Z",
      },
    ]
    const now = new Date("2026-07-23T00:30:00.000Z")
    const result = evaluateCompatibilityGate({ ...base, health, now })
    expect(result.accepted).toBe(false)
    // Health can never UP-rank: an unsupported capability with a closed
    // circuit stays unsupported.
    const upRank = evaluateCompatibilityGate({
      ...base,
      requires: ["prompt-caching"],
      health: [],
      now,
    })
    expect(upRank.accepted).toBe(false)
  })
})

describe("capability health circuit", () => {
  it("opens after the threshold, closes on success, and expires", () => {
    const now = new Date("2026-07-23T00:00:00.000Z")
    let entries: ReturnType<typeof recordCapabilityFailure> = []
    for (let i = 0; i < CIRCUIT_OPEN_THRESHOLD; i += 1) {
      expect(isCircuitOpen(entries, "k", "mcp", now)).toBe(false)
      entries = recordCapabilityFailure(entries, "k", "mcp", now)
    }
    expect(isCircuitOpen(entries, "k", "mcp", now)).toBe(true)
    // Bounded window: it expires on its own.
    expect(isCircuitOpen(entries, "k", "mcp", new Date("2026-07-23T01:00:00.000Z"))).toBe(false)
    // Success closes it immediately.
    entries = recordCapabilitySuccess(entries, "k", "mcp")
    expect(isCircuitOpen(entries, "k", "mcp", now)).toBe(false)
    // Other keys/capabilities are unaffected — never the whole provider.
    entries = recordCapabilityFailure(entries, "k", "mcp", now)
    expect(isCircuitOpen(entries, "k", "streaming", now)).toBe(false)
    expect(isCircuitOpen(entries, "other", "mcp", now)).toBe(false)
  })
})

describe("computeStaleness", () => {
  it("reports every drifted axis, not just the first", () => {
    const verdict = computeStaleness(manifest(), {
      ...current,
      agentSdkVersion: "9.9.9",
      suiteVersion: "42",
    })
    expect(verdict.stale).toBe(true)
    expect(verdict.reasons).toHaveLength(2)
  })

  it("is fresh when every axis matches and no expiry passed", () => {
    expect(computeStaleness(manifest(), current).stale).toBe(false)
  })
})
