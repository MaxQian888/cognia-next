import { canonicalizeSpec, computeExecutionFingerprint } from "./fingerprint"

describe("canonicalizeSpec", () => {
  it("sorts object keys recursively so key order never matters", () => {
    const a = canonicalizeSpec({ b: 1, a: { d: 2, c: 3 } })
    const b = canonicalizeSpec({ a: { c: 3, d: 2 }, b: 1 })
    expect(a).toBe(b)
    expect(a).toBe('{"a":{"c":3,"d":2},"b":1}')
  })

  it("drops volatile keys and undefined values, but preserves arrays in order", () => {
    const json = canonicalizeSpec({
      runtimeAdapter: "ai-sdk",
      executionFingerprint: "stale",
      traceId: "t-1",
      at: "2026-07-23T00:00:00Z",
      attemptId: "a1",
      turnId: "turn-1",
      nothing: undefined,
      capabilities: ["streaming", "mcp"],
    })
    expect(json).toBe('{"capabilities":["streaming","mcp"],"runtimeAdapter":"ai-sdk"}')
    // Array order is semantic (candidate ordering) — must NOT be sorted.
    expect(canonicalizeSpec({ x: [2, 1] })).not.toBe(canonicalizeSpec({ x: [1, 2] }))
  })

  it("strips volatile keys at any nesting depth", () => {
    const json = canonicalizeSpec({
      identity: { sessionId: "s1", runId: "r1", attemptId: "a-volatile", turnId: "t-volatile" },
    })
    expect(json).toBe('{"identity":{"runId":"r1","sessionId":"s1"}}')
  })
})

describe("computeExecutionFingerprint", () => {
  const spec = {
    specVersion: 1,
    runtimeAdapter: "claude-agent-sdk",
    modelBindings: { primary: "claude-sonnet-5", fast: "claude-haiku-4-5-20251001" },
    route: { kind: "gateway", routePolicy: "gateway-required", routePinId: "pin-1" },
    hostRef: "desktop-sidecar",
  }

  it("is stable across repeated calls and key reordering", () => {
    const first = computeExecutionFingerprint(spec)
    const second = computeExecutionFingerprint({
      hostRef: "desktop-sidecar",
      route: { routePinId: "pin-1", kind: "gateway", routePolicy: "gateway-required" },
      modelBindings: { fast: "claude-haiku-4-5-20251001", primary: "claude-sonnet-5" },
      runtimeAdapter: "claude-agent-sdk",
      specVersion: 1,
    })
    expect(first).toBe(second)
    expect(first).toMatch(/^aexf1-[0-9a-f]{32}$/)
  })

  it("ignores volatile fields (attempt ids, timestamps, prior fingerprints)", () => {
    const withVolatile = computeExecutionFingerprint({
      ...spec,
      executionFingerprint: "aexf1-deadbeef",
      at: "2026-07-23T12:00:00Z",
      attemptId: "a99",
    })
    expect(withVolatile).toBe(computeExecutionFingerprint(spec))
  })

  it("survives the v1 -> v2 contract upgrade unchanged", () => {
    // The fingerprint identifies an execution *configuration*. Re-serialising
    // the same configuration under a newer contract version is not a different
    // execution, so an in-flight run's fingerprint must still match after the
    // upgrade — recovery and ticket-remint both compare on it.
    const v1 = computeExecutionFingerprint({ ...spec, specVersion: 1 })
    const v2 = computeExecutionFingerprint({
      ...spec,
      specVersion: 2,
      capabilities: {
        effective: ["streaming"],
        disabledOptional: [],
        support: { streaming: { support: "native" } },
      },
    })
    const v2WithMoreVerdicts = computeExecutionFingerprint({
      ...spec,
      specVersion: 2,
      capabilities: {
        effective: ["streaming"],
        disabledOptional: [],
        // A later stage implementing a capability adds verdicts here. That is
        // not a configuration change and must not move the fingerprint.
        support: {
          streaming: { support: "native" },
          "output.structured": { support: "unsupported", reason: "not implemented yet" },
        },
      },
    })

    expect(v2).toBe(v2WithMoreVerdicts)
    expect(v1).not.toBe(v2) // `capabilities.effective` genuinely differs here
    expect(computeExecutionFingerprint({ ...spec, specVersion: 2 })).toBe(v1)
  })

  it("changes when runtime, route or model binding change", () => {
    const base = computeExecutionFingerprint(spec)
    expect(computeExecutionFingerprint({ ...spec, runtimeAdapter: "ai-sdk" })).not.toBe(base)
    expect(
      computeExecutionFingerprint({
        ...spec,
        route: { kind: "direct", routePolicy: "direct" },
      })
    ).not.toBe(base)
    expect(
      computeExecutionFingerprint({
        ...spec,
        modelBindings: { primary: "claude-opus-4-8" },
      })
    ).not.toBe(base)
  })

  it("distinguishes multi-byte UTF-8 inputs deterministically", () => {
    const zh = computeExecutionFingerprint({ ...spec, deploymentRef: "部署-一" })
    const zh2 = computeExecutionFingerprint({ ...spec, deploymentRef: "部署-二" })
    expect(zh).not.toBe(zh2)
    expect(zh).toBe(computeExecutionFingerprint({ ...spec, deploymentRef: "部署-一" }))
  })
})
