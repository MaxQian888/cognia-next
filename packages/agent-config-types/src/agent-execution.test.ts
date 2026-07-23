import {
  AGENT_CAPABILITY_IDS,
  isAgentCapabilityId,
  isAgentEventEnvelope,
  validateAgentExecutionPolicy,
  validateAgentExecutionSendSpec,
  validateResolvedAgentExecutionSpec,
} from "./agent-execution"
import type {
  AgentEventEnvelope,
  AgentExecutionPolicy,
  AgentExecutionSendSpec,
  ResolvedAgentExecutionSpec,
} from "./agent-execution"

const validPolicy: AgentExecutionPolicy = {
  executionKind: "agent",
  runtimePolicy: "auto",
  routePolicy: "gateway-preferred",
  requires: ["tools.ordinary", "streaming"],
  prefers: ["prompt-caching"],
  fallbackPolicy: "none",
}

const validSpec: ResolvedAgentExecutionSpec = {
  specVersion: 1,
  identity: { sessionId: "s1", runId: "r1", attemptId: "a1" },
  executionFingerprint: "fp-abc",
  executionKind: "agent",
  runtimeAdapter: "claude-agent-sdk",
  runtimePolicySource: "auto",
  modelBindings: { primary: "claude-sonnet-5", fast: "claude-haiku-4-5-20251001" },
  route: { kind: "direct", routePolicy: "direct", credentialProfileRef: "cp-1" },
  hostRef: "desktop-sidecar",
  compatibility: { evidence: "native" },
  capabilities: { effective: ["streaming", "tools.ordinary"], disabledOptional: [] },
  fallbackPolicy: "none",
}

const validSendSpec: AgentExecutionSendSpec = {
  specVersion: 1,
  executionFingerprint: "fp-abc",
  runtimeAdapter: "claude-agent-sdk",
  executionKind: "agent",
  route: { kind: "gateway", endpoint: "http://127.0.0.1:47823/v1", ticketId: "tk-1" },
  modelBindings: { primary: "claude-sonnet-5" },
  capabilities: { effective: ["streaming"], disabledOptional: [] },
  identity: { runId: "r1", attemptId: "a1" },
  hostRef: "desktop-sidecar",
}

describe("validateAgentExecutionPolicy", () => {
  it("accepts a full valid policy", () => {
    const result = validateAgentExecutionPolicy(validPolicy)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.runtimePolicy).toBe("auto")
  })

  it("accepts pinned execution targets and rejects malformed ones", () => {
    const pinned = validateAgentExecutionPolicy({
      ...validPolicy,
      executionTarget: { mode: "pinned", hostRef: "host-2" },
    })
    expect(pinned.ok).toBe(true)

    const badPin = validateAgentExecutionPolicy({
      ...validPolicy,
      executionTarget: { mode: "pinned" },
    })
    expect(badPin.ok).toBe(false)
  })

  it("rejects non-objects, bad enums and unknown capability ids", () => {
    expect(validateAgentExecutionPolicy(null).ok).toBe(false)
    expect(validateAgentExecutionPolicy("policy").ok).toBe(false)

    const badEnum = validateAgentExecutionPolicy({ ...validPolicy, routePolicy: "maybe" })
    expect(badEnum.ok).toBe(false)
    if (!badEnum.ok) {
      expect(badEnum.errors.join(" ")).toContain("routePolicy")
    }

    const badCaps = validateAgentExecutionPolicy({ ...validPolicy, requires: ["not-a-cap"] })
    expect(badCaps.ok).toBe(false)

    const badAffinity = validateAgentExecutionPolicy({
      ...validPolicy,
      credentialAffinity: "forever",
    })
    expect(badAffinity.ok).toBe(false)
  })
})

describe("validateResolvedAgentExecutionSpec", () => {
  it("accepts a valid direct spec and a valid gateway spec", () => {
    expect(validateResolvedAgentExecutionSpec(validSpec).ok).toBe(true)

    const gateway = validateResolvedAgentExecutionSpec({
      ...validSpec,
      route: {
        kind: "gateway",
        routePolicy: "gateway-required",
        routePinId: "pin-1",
        ticketRef: "tk-1",
      },
      credential: { profileRef: "cp-1", affinity: "sticky-with-failover" },
    })
    expect(gateway.ok).toBe(true)
  })

  it("rejects missing identity fields, bad version and bad route kinds", () => {
    const noIdentity = validateResolvedAgentExecutionSpec({
      ...validSpec,
      identity: { sessionId: "s1", runId: "", attemptId: "a1" },
    })
    expect(noIdentity.ok).toBe(false)

    const badVersion = validateResolvedAgentExecutionSpec({ ...validSpec, specVersion: 2 })
    expect(badVersion.ok).toBe(false)

    const badRoute = validateResolvedAgentExecutionSpec({
      ...validSpec,
      route: { kind: "carrier-pigeon" },
    })
    expect(badRoute.ok).toBe(false)
  })

  it("rejects credential blobs that carry secret material", () => {
    const withSecret = validateResolvedAgentExecutionSpec({
      ...validSpec,
      credential: { profileRef: "cp-1", affinity: "per-request", apiKey: "sk-live" },
    })
    expect(withSecret.ok).toBe(false)
    if (!withSecret.ok) {
      expect(withSecret.errors.join(" ")).toContain("secret material")
    }
  })

  it("requires primary model binding", () => {
    const noPrimary = validateResolvedAgentExecutionSpec({
      ...validSpec,
      modelBindings: { fast: "claude-haiku-4-5-20251001" },
    })
    expect(noPrimary.ok).toBe(false)
  })
})

describe("validateAgentExecutionSendSpec", () => {
  it("accepts gateway and direct variants", () => {
    expect(validateAgentExecutionSendSpec(validSendSpec).ok).toBe(true)
    expect(
      validateAgentExecutionSendSpec({
        ...validSendSpec,
        route: { kind: "direct", credentialProfileRef: "cp-1" },
      }).ok
    ).toBe(true)
  })

  it("rejects gateway routes without endpoint/ticket and identities without runId", () => {
    const noTicket = validateAgentExecutionSendSpec({
      ...validSendSpec,
      route: { kind: "gateway", endpoint: "http://127.0.0.1:1" },
    })
    expect(noTicket.ok).toBe(false)

    const noRun = validateAgentExecutionSendSpec({
      ...validSendSpec,
      identity: { attemptId: "a1" },
    })
    expect(noRun.ok).toBe(false)
  })
})

describe("isAgentEventEnvelope", () => {
  const envelope: AgentEventEnvelope = {
    eventId: "s1:a1:0",
    sequence: 0,
    sessionId: "s1",
    runId: "r1",
    turnId: "t1",
    attemptId: "a1",
    hostRef: "desktop-sidecar",
    runtime: "claude-agent-sdk",
    timestamp: "2026-07-23T00:00:00.000Z",
    event: { kind: "text-delta", delta: "hello" },
  }

  it("narrows valid envelopes across event kinds", () => {
    expect(isAgentEventEnvelope(envelope)).toBe(true)
    expect(
      isAgentEventEnvelope({
        ...envelope,
        event: { kind: "capability-error", capability: "steer", command: "steer" },
      })
    ).toBe(true)
    expect(
      isAgentEventEnvelope({
        ...envelope,
        event: { kind: "failure", code: "upstream_error", message: "boom" },
      })
    ).toBe(true)
  })

  it("rejects envelopes with missing ids, negative sequence or unknown kind", () => {
    expect(isAgentEventEnvelope(null)).toBe(false)
    expect(isAgentEventEnvelope({ ...envelope, sessionId: "" })).toBe(false)
    expect(isAgentEventEnvelope({ ...envelope, sequence: -1 })).toBe(false)
    expect(isAgentEventEnvelope({ ...envelope, sequence: 1.5 })).toBe(false)
    expect(isAgentEventEnvelope({ ...envelope, event: { kind: "mystery" } })).toBe(false)
    expect(isAgentEventEnvelope({ ...envelope, providerAttemptId: 3 })).toBe(false)
  })
})

describe("capability id registry", () => {
  it("has unique ids and a working narrow guard", () => {
    expect(new Set(AGENT_CAPABILITY_IDS).size).toBe(AGENT_CAPABILITY_IDS.length)
    expect(isAgentCapabilityId("tools.parallel")).toBe(true)
    expect(isAgentCapabilityId("tools.telepathy")).toBe(false)
    expect(isAgentCapabilityId(42)).toBe(false)
  })
})
