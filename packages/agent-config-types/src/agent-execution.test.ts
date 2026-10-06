import {
  AGENT_CAPABILITY_IDS,
  RESOLVED_SPEC_VERSION,
  isAgentCapabilityId,
  isKnownCanonicalAgentEventKind,
  upgradeResolvedAgentExecutionSpec,
  validateAgentExecutionPolicy,
  isRemoteExternalBinding,
  validateAgentExecutionSendSpec,
  validateResolvedAgentExecutionSpec,
} from "./agent-execution"
import type {
  CanonicalAgentEvent,
  AgentExecutionPolicy,
  AgentExecutionSendSpec,
  ResolvedAgentExecutionSpec,
} from "./agent-execution"

import SDK_SURFACE from "../../../protocol/agent-sdk-surface.json"

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

    // 1 and 2 are both live; 3 is not. (Before contract v2 this case used 2,
    // which would now pass the version check and fail only on the missing
    // `capabilities.support` — right answer, wrong reason.)
    const badVersion = validateResolvedAgentExecutionSpec({ ...validSpec, specVersion: 3 })
    expect(badVersion.ok).toBe(false)
    if (!badVersion.ok) expect(badVersion.errors.join()).toMatch(/specVersion must be 1 or 2/)

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

describe("canonical events and the SDK surface manifest", () => {
  it("carries a kind for every SDK message the surface manifest declares", () => {
    // The 39-member union projects onto this vocabulary. `check:sdk-surface`
    // verifies the manifest against the installed `sdk.d.ts`; this verifies the
    // other end of the same claim — that every kind the manifest promises
    // actually exists in the contract.
    const declared = new Set(
      Object.values(
        SDK_SURFACE.surface.messages as Record<string, { canonical?: string[] }>
      ).flatMap((entry) => entry.canonical ?? [])
    )
    expect(declared.size).toBeGreaterThan(0)
    for (const kind of declared) {
      expect(isKnownCanonicalAgentEventKind(kind)).toBe(true)
    }
  })
})

describe("capability id registry", () => {
  it("has unique ids and a working narrow guard", () => {
    expect(new Set(AGENT_CAPABILITY_IDS).size).toBe(AGENT_CAPABILITY_IDS.length)
    expect(isAgentCapabilityId("tools.parallel")).toBe(true)
    expect(isAgentCapabilityId("tools.telepathy")).toBe(false)
    expect(isAgentCapabilityId(42)).toBe(false)
  })

  it("carries the 16 SDK-parity ids added by contract v2", () => {
    const sdkParity = [
      "output.structured",
      "session.store",
      "session.manage",
      "permissions.update-rules",
      "hooks.lifecycle",
      "input.elicitation",
      "input.dialog",
      "plugins.native",
      "skills.native",
      "mcp.dynamic",
      "subagents.manage",
      "tasks.background",
      "commands.dynamic",
      "sandbox.native",
      "observability.child",
      "startup.prewarm",
    ]
    for (const id of sdkParity) expect(isAgentCapabilityId(id)).toBe(true)
    expect(AGENT_CAPABILITY_IDS).toHaveLength(40)
  })
})

describe("contract v2: capabilities.support", () => {
  const v2Spec: ResolvedAgentExecutionSpec = {
    ...validSpec,
    specVersion: 2,
    capabilities: {
      ...validSpec.capabilities,
      support: {
        streaming: { support: "native" },
        "tools.ordinary": { support: "native" },
      },
    },
  }

  it("accepts a v2 spec carrying verdicts", () => {
    expect(validateResolvedAgentExecutionSpec(v2Spec).ok).toBe(true)
  })

  it("requires support on a v2 spec", () => {
    const result = validateResolvedAgentExecutionSpec({
      ...validSpec,
      specVersion: 2,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.join()).toMatch(/support is required on a v2 spec/)
  })

  it("rejects support on a v1 spec", () => {
    const result = validateResolvedAgentExecutionSpec({
      ...v2Spec,
      specVersion: 1,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.join()).toMatch(/not valid on a v1 spec/)
  })

  it("makes a non-native verdict explain itself", () => {
    // An `unsupported` with no reason is indistinguishable from a half-written
    // adapter, which is exactly the ambiguity fail-closed exists to prevent.
    const result = validateResolvedAgentExecutionSpec({
      ...v2Spec,
      capabilities: {
        ...v2Spec.capabilities,
        support: { streaming: { support: "unsupported" } },
      },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.join()).toMatch(/must carry a reason/)
  })

  it("accepts `equivalent` when it explains how", () => {
    const result = validateResolvedAgentExecutionSpec({
      ...v2Spec,
      capabilities: {
        ...v2Spec.capabilities,
        support: {
          streaming: { support: "native" },
          "output.structured": {
            support: "equivalent",
            reason: "provider-native JSON schema rather than the SDK outputFormat",
          },
        },
      },
    })
    expect(result.ok).toBe(true)
  })

  it("rejects unknown capability ids and unknown support values", () => {
    const unknownId = validateResolvedAgentExecutionSpec({
      ...v2Spec,
      capabilities: {
        ...v2Spec.capabilities,
        support: { "tools.telepathy": { support: "native" } },
      },
    })
    expect(unknownId.ok).toBe(false)

    const unknownSupport = validateResolvedAgentExecutionSpec({
      ...v2Spec,
      capabilities: { ...v2Spec.capabilities, support: { streaming: { support: "sort-of" } } },
    })
    expect(unknownSupport.ok).toBe(false)
  })
})

describe("upgradeResolvedAgentExecutionSpec", () => {
  it("upcasts v1 to v2 and marks the prior effective set native, with a reason", () => {
    const upgraded = upgradeResolvedAgentExecutionSpec(validSpec)
    expect(upgraded.specVersion).toBe(2)
    expect(upgraded.capabilities.support?.streaming?.support).toBe("native")
    expect(upgraded.capabilities.support?.["tools.ordinary"]?.support).toBe("native")
    expect(validateResolvedAgentExecutionSpec(upgraded).ok).toBe(true)
  })

  it("does not invent verdicts for the v2-only capabilities", () => {
    const upgraded = upgradeResolvedAgentExecutionSpec(validSpec)
    expect(upgraded.capabilities.support?.["session.store"]).toBeUndefined()
    expect(upgraded.capabilities.support?.["output.structured"]).toBeUndefined()
  })

  it("is idempotent", () => {
    const once = upgradeResolvedAgentExecutionSpec(validSpec)
    expect(upgradeResolvedAgentExecutionSpec(once)).toBe(once)
  })

  it("leaves every other field untouched", () => {
    const upgraded = upgradeResolvedAgentExecutionSpec(validSpec)
    const { specVersion: _v, capabilities: _c, ...restUpgraded } = upgraded
    const { specVersion: _v1, capabilities: _c1, ...restOriginal } = validSpec
    expect(restUpgraded).toEqual(restOriginal)
    expect(upgraded.capabilities.effective).toEqual(validSpec.capabilities.effective)
  })

  it("RESOLVED_SPEC_VERSION is what new specs are emitted as", () => {
    expect(RESOLVED_SPEC_VERSION).toBe(2)
  })
})

describe("v3 external binding", () => {
  const v3 = (externalBinding: unknown) => ({
    ...validSendSpec,
    specVersion: 3,
    externalBinding,
  })

  it("accepts a spec with no binding — that is a built-in sidecar turn", () => {
    expect(validateAgentExecutionSendSpec({ ...validSendSpec, specVersion: 3 }).ok).toBe(true)
  })

  it("accepts a local binding", () => {
    expect(validateAgentExecutionSendSpec(v3({ kind: "local-external", agentId: "a" })).ok).toBe(
      true
    )
  })

  it("accepts a complete remote binding", () => {
    expect(
      validateAgentExecutionSendSpec(
        v3({
          kind: "remote-external",
          targetId: "host-1",
          configId: "eac_1",
          revision: "eacr_1",
          lifecycleGeneration: 2,
        })
      ).ok
    ).toBe(true)
  })

  // A remote binding is a claim about another machine's state; an incomplete
  // one cannot be repaired by a default. A missing generation defaulted to 0
  // would never match a real one (permanent refusal); a missing revision read
  // as "any" would delete the check.
  it.each([
    ["targetId", { configId: "eac_1", revision: "eacr_1", lifecycleGeneration: 1 }],
    ["configId", { targetId: "h", revision: "eacr_1", lifecycleGeneration: 1 }],
    ["revision", { targetId: "h", configId: "eac_1", lifecycleGeneration: 1 }],
    ["lifecycleGeneration", { targetId: "h", configId: "eac_1", revision: "eacr_1" }],
  ])("refuses a remote binding missing %s", (_field, partial) => {
    const result = validateAgentExecutionSendSpec(v3({ kind: "remote-external", ...partial }))
    expect(result.ok).toBe(false)
  })

  it.each([0, -1, 1.5, "2"])("refuses lifecycleGeneration %p", (generation) => {
    expect(
      validateAgentExecutionSendSpec(
        v3({
          kind: "remote-external",
          targetId: "h",
          configId: "eac_1",
          revision: "eacr_1",
          lifecycleGeneration: generation,
        })
      ).ok
    ).toBe(false)
  })

  it("refuses an unknown binding kind", () => {
    expect(validateAgentExecutionSendSpec(v3({ kind: "somewhere-else" })).ok).toBe(false)
  })

  // An older host reading a v3 field off a v1/v2 spec would act on a binding
  // its peer never agreed to send.
  it("refuses a binding on a pre-v3 spec", () => {
    const result = validateAgentExecutionSendSpec({
      ...validSendSpec,
      specVersion: 2,
      externalBinding: { kind: "local-external", agentId: "a" },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.join()).toMatch(/requires specVersion 3/)
  })

  it("still accepts v1 and v2 specs unchanged", () => {
    expect(validateAgentExecutionSendSpec({ ...validSendSpec, specVersion: 1 }).ok).toBe(true)
    expect(validateAgentExecutionSendSpec(validSendSpec).ok).toBe(true)
  })

  it("refuses specVersion 4", () => {
    expect(validateAgentExecutionSendSpec({ ...validSendSpec, specVersion: 4 }).ok).toBe(false)
  })
})

describe("isRemoteExternalBinding", () => {
  it("separates the two arms and tolerates absence", () => {
    expect(isRemoteExternalBinding(undefined)).toBe(false)
    expect(isRemoteExternalBinding({ kind: "local-external", agentId: "a" })).toBe(false)
    expect(
      isRemoteExternalBinding({
        kind: "remote-external",
        targetId: "h",
        configId: "c",
        revision: "r",
        lifecycleGeneration: 1,
      })
    ).toBe(true)
  })
})

it("recognizes the generic extension presentation event", () => {
  expect(isKnownCanonicalAgentEventKind("extension-ui")).toBe(true)
  const event: CanonicalAgentEvent = {
    kind: "extension-ui",
    id: "widget-1",
    update: { kind: "widget", key: "extension", lines: ["hello"], placement: "belowEditor" },
  }
  expect(JSON.parse(JSON.stringify(event))).toEqual(event)
})
