import {
  AGENT_CAPABILITY_IDS,
  validateResolvedAgentExecutionSpec,
  type AgentCapabilityId,
} from "@cognia/agent-config-types/agent-execution"

import type { AgentExecutionFlag } from "./feature-flags"
import {
  channelFromSpec,
  rebindResolvedAgentExecutionHost,
  resolveAgentExecutionSpec,
  RUNTIME_CAPABILITIES,
  sendSpecFromResolved,
  type AgentExecutionResolveInput,
} from "./resolve-agent-execution-spec"

/**
 * Some capability the Claude rail genuinely does not serve, picked from the
 * table rather than written down. Hardcoding one is how the previous version
 * of these tests ended up asserting a refusal for `steer` — a capability the
 * rail had all along.
 */
const UNSERVED_BY_CLAUDE = (() => {
  const served = new Set(RUNTIME_CAPABILITIES["claude-agent-sdk"])
  const id = AGENT_CAPABILITY_IDS.find((c) => !served.has(c))
  if (!id) throw new Error("claude-agent-sdk now serves every capability — pick a new probe")
  return id
})()

const flagsOff: Record<AgentExecutionFlag, boolean> = {
  agentTeamRemoteDispatch: false,
  genericAgentHostCommands: false,
  gatewayAgentRouteTickets: false,
  headlessLlmGateway: false,
  experimentalAnthropicDeploymentAgentSdk: false,
  claudeSdkParityV1: false,
  claudeSdkSessionStore: false,
  claudeSdkCheckpoint: false,
  claudeSdkPrewarm: false,
}

const desktop = { isTauri: true, isHeadlessHost: false }
const headless = { isTauri: false, isHeadlessHost: true }
const web = { isTauri: false, isHeadlessHost: false }

function baseInput(
  overrides: Partial<AgentExecutionResolveInput> = {}
): AgentExecutionResolveInput {
  return {
    surface: "agent-executor",
    environment: desktop,
    flags: flagsOff,
    now: "2026-07-23T00:00:00.000Z",
    ...overrides,
  }
}

describe("resolveAgentExecutionSpec — legacy parity (shadow mode)", () => {
  it("reproduces the provider-id dispatch decision under auto/legacy", () => {
    const anthropic = resolveAgentExecutionSpec(
      baseInput({ legacy: { providerId: "anthropic", toolsEnabled: true, requireTools: true } })
    )
    expect(anthropic.spec.runtimeAdapter).toBe("claude-agent-sdk")
    expect(anthropic.spec.runtimePolicySource).toBe("legacy-mapped")

    const openai = resolveAgentExecutionSpec(
      baseInput({ legacy: { providerId: "openai", toolsEnabled: true, requireTools: true } })
    )
    expect(openai.spec.runtimeAdapter).toBe("ai-sdk")

    const relay = resolveAgentExecutionSpec(
      baseInput({ legacy: { providerId: "glm-anthropic", toolsEnabled: true } })
    )
    expect(relay.spec.runtimeAdapter).toBe("ai-sdk")

    const external = resolveAgentExecutionSpec(
      baseInput({ surface: "team", legacy: { runtime: "codex" } })
    )
    expect(external.spec.runtimeAdapter).toBe("external")
  })

  it("produces valid, fingerprint-stable specs for identical inputs", () => {
    const input = baseInput({
      legacy: { providerId: "anthropic", modelId: "claude-sonnet-5", toolsEnabled: true },
      identity: { sessionId: "s1", runId: "r1", attemptId: "a1" },
    })
    const first = resolveAgentExecutionSpec(input)
    const second = resolveAgentExecutionSpec(input)

    expect(validateResolvedAgentExecutionSpec(first.spec).ok).toBe(true)
    expect(first.spec.executionFingerprint).toBe(second.spec.executionFingerprint)
    expect(first.spec).toEqual(second.spec)
    // Trace ids are volatile and unique per resolution.
    expect(first.trace.traceId).not.toBe(second.trace.traceId)
  })

  it("keeps route kind direct while gateway tickets are flagged off, but records the policy", () => {
    const required = resolveAgentExecutionSpec(
      baseInput({ legacy: { providerId: "anthropic", proxyMode: "always", toolsEnabled: true } })
    )
    expect(required.spec.route.kind).toBe("direct")
    expect(required.spec.route.routePolicy).toBe("gateway-required")

    const ticketed = resolveAgentExecutionSpec(
      baseInput({
        legacy: { providerId: "anthropic", proxyMode: "always", toolsEnabled: true },
        flags: { ...flagsOff, gatewayAgentRouteTickets: true },
      })
    )
    expect(ticketed.spec.route.kind).toBe("gateway")
  })

  it("applies the toolsEnabled/requireTools migration table", () => {
    const legacyFallback = resolveAgentExecutionSpec(
      baseInput({ legacy: { providerId: "anthropic", toolsEnabled: true } })
    )
    expect(legacyFallback.spec.executionKind).toBe("agent")
    expect(legacyFallback.spec.fallbackPolicy).toBe("completion")
    expect(legacyFallback.spec.legacyMigrated).toBe(true)

    const completion = resolveAgentExecutionSpec(
      baseInput({ legacy: { providerId: "anthropic", toolsEnabled: false } })
    )
    expect(completion.spec.executionKind).toBe("completion")
    expect(completion.spec.fallbackPolicy).toBe("none")
  })

  it("managed/headless policy strips the legacy completion fallback", () => {
    const result = resolveAgentExecutionSpec(
      baseInput({
        environment: { ...headless, prohibitCompletionFallback: true },
        legacy: { providerId: "anthropic", toolsEnabled: true },
      })
    )
    expect(result.spec.fallbackPolicy).toBe("none")
    expect(result.spec.hostRef).toBe("headless-agent-host")
    expect(result.spec.route.routePolicy).toBe("gateway-required")
  })
})

describe("resolveAgentExecutionSpec — explicit policy", () => {
  it("honors explicit runtime, kind, route, deployment and credential refs", () => {
    const result = resolveAgentExecutionSpec(
      baseInput({
        policy: {
          executionKind: "agent",
          runtimePolicy: "claude-agent-sdk",
          routePolicy: "direct",
          deploymentRef: "dep-1",
          credentialProfileRef: "cp-1",
          credentialAffinity: "session-sticky",
        },
        legacy: { providerId: "openai" },
      })
    )
    expect(result.spec.runtimeAdapter).toBe("claude-agent-sdk")
    expect(result.spec.runtimePolicySource).toBe("explicit")
    expect(result.spec.deploymentRef).toBe("dep-1")
    expect(result.spec.credential).toEqual({ profileRef: "cp-1", affinity: "session-sticky" })
    expect(result.spec.fallbackPolicy).toBe("none")
    expect(result.spec.legacyMigrated).toBeUndefined()
  })

  it("pins the host from an explicit pinned execution target", () => {
    const result = resolveAgentExecutionSpec(
      baseInput({
        policy: {
          executionKind: "agent",
          runtimePolicy: "ai-sdk",
          routePolicy: "direct",
          executionTarget: { mode: "pinned", hostRef: "host-42" },
        },
      })
    )
    expect(result.spec.hostRef).toBe("host-42")
  })

  it("reports missing hard capabilities and disables unavailable preferred ones", () => {
    const result = resolveAgentExecutionSpec(
      baseInput({
        policy: {
          executionKind: "agent",
          runtimePolicy: "ai-sdk",
          routePolicy: "direct",
          requires: ["subagents.native", "streaming"],
          prefers: ["prompt-caching"],
        },
      })
    )
    expect(result.missingRequired).toEqual(["subagents.native"])
    expect(result.spec.capabilities.disabledOptional).toEqual(["prompt-caching"])
    expect(result.spec.capabilities.effective).toContain("streaming")
    expect(result.spec.capabilities.effective).not.toContain("prompt-caching")
  })

  it("clamps theoretical runtime capabilities to the selected host backend", () => {
    const result = resolveAgentExecutionSpec(
      baseInput({
        environment: {
          ...headless,
          hostCapabilities: ["streaming", "tools.ordinary"],
        },
        policy: {
          executionKind: "agent",
          runtimePolicy: "claude-agent-sdk",
          routePolicy: "direct",
          requires: ["streaming", "mcp"],
          prefers: ["tools.parallel"],
        },
      })
    )

    expect(result.missingRequired).toEqual(["mcp"])
    expect(result.spec.capabilities.effective).toEqual(["streaming", "tools.ordinary"])
    expect(result.spec.capabilities.disabledOptional).toEqual(["tools.parallel"])
  })

  it("rebinds an auto-selected host through the resolver-owned fingerprint helper", () => {
    const { spec } = resolveAgentExecutionSpec(baseInput({ environment: headless }))
    const rebound = rebindResolvedAgentExecutionHost(spec, "device:authenticated")

    expect(rebound.hostRef).toBe("device:authenticated")
    expect(rebound.executionFingerprint).not.toBe(spec.executionFingerprint)
    expect(rebindResolvedAgentExecutionHost(spec, "device:authenticated")).toEqual(rebound)
    expect(() => rebindResolvedAgentExecutionHost(spec, " ")).toThrow("hostRef")
  })
})

describe("decision trace", () => {
  it("carries only ids/enums — no secret-shaped values for adversarial inputs", () => {
    const result = resolveAgentExecutionSpec(
      baseInput({
        legacy: {
          providerId: "custom-provider",
          modelId: "some-model",
          proxyMode: "preferred",
          toolsEnabled: true,
        },
        policy: { credentialProfileRef: "cp-ref-only" },
      })
    )
    const serialized = JSON.stringify(result.trace)
    expect(serialized).not.toMatch(/sk-[a-zA-Z0-9]/)
    expect(serialized.toLowerCase()).not.toContain("bearer")
    expect(result.trace.legacy.providerId).toBe("custom-provider")
    expect(result.trace.resolved.routeKind).toBe("direct")
  })
})

describe("channelFromSpec", () => {
  it("maps specs to legacy channels for divergence comparison", () => {
    const agent = resolveAgentExecutionSpec(
      baseInput({ legacy: { providerId: "anthropic", toolsEnabled: true, requireTools: true } })
    )
    expect(channelFromSpec(agent.spec, desktop)).toBe("sidecar")
    expect(channelFromSpec(agent.spec, web)).toBe("text")
    expect(channelFromSpec(agent.spec, headless)).toBe("sidecar")

    const completion = resolveAgentExecutionSpec(
      baseInput({ legacy: { providerId: "anthropic", toolsEnabled: false } })
    )
    expect(channelFromSpec(completion.spec, desktop)).toBe("text")

    const external = resolveAgentExecutionSpec(
      baseInput({ surface: "team", legacy: { runtime: "codex" } })
    )
    expect(channelFromSpec(external.spec, desktop)).toBe("external")
  })
})

describe("sendSpecFromResolved", () => {
  it("projects a direct spec onto the secret-free SendOptions wire shape", () => {
    const { spec } = resolveAgentExecutionSpec(
      baseInput({
        legacy: { providerId: "anthropic", modelId: "claude-opus-4-8", toolsEnabled: true },
        identity: { sessionId: "s-1" },
      })
    )
    const sent = sendSpecFromResolved(spec)
    expect(sent).toEqual(
      expect.objectContaining({
        // Mirrors the resolved spec rather than a literal: a v1 wire spec
        // would silently drop `capabilities.support`, which the sidecar needs
        // in order to fail closed on its own side.
        specVersion: spec.specVersion,
        executionFingerprint: spec.executionFingerprint,
        runtimeAdapter: "claude-agent-sdk",
        executionKind: "agent",
        route: { kind: "direct" },
        modelBindings: spec.modelBindings,
        hostRef: spec.hostRef,
      })
    )
    expect(sent.identity).toEqual({ runId: "s-1", attemptId: "a1" })
    expect(JSON.stringify(sent)).not.toMatch(/sk-|api[_-]?key|bearer|token/i)
    // The capability verdicts must survive the projection — the sidecar reads
    // them to refuse a control before it reaches the live Query.
    expect(sent.capabilities.support).toEqual(spec.capabilities.support)
  })

  it("carries endpoint+ticketId ONLY when the caller minted a ticket for a gateway route", () => {
    const { spec } = resolveAgentExecutionSpec(
      baseInput({
        flags: { ...flagsOff, gatewayAgentRouteTickets: true },
        legacy: { providerId: "anthropic", proxyMode: "always", toolsEnabled: true },
      })
    )
    expect(spec.route.kind).toBe("gateway")

    // No minted ticket ⇒ the wire shape degrades to a direct route (fail-safe:
    // never emit a gateway route the sidecar cannot authenticate against).
    expect(sendSpecFromResolved(spec).route).toEqual({ kind: "direct" })

    const withTicket = sendSpecFromResolved(spec, {
      endpoint: "http://127.0.0.1:18789",
      ticketId: "rt-1",
    })
    expect(withTicket.route).toEqual({
      kind: "gateway",
      endpoint: "http://127.0.0.1:18789",
      ticketId: "rt-1",
    })
  })
})

describe("runtime capability tables", () => {
  it("only claude-agent-sdk offers native subagents; ai-sdk never steers", () => {
    expect(RUNTIME_CAPABILITIES["claude-agent-sdk"]).toContain("subagents.native")
    expect(RUNTIME_CAPABILITIES["ai-sdk"]).toContain("session.resume")
    expect(RUNTIME_CAPABILITIES["ai-sdk"]).not.toContain("subagents.native")

    // Steering is served by the claude rail and the external rail, and by
    // neither ai-sdk nor anything else. `routeSteer()` in the sidecar refuses
    // every non-anthropic provider outright, so listing it for ai-sdk would
    // promise a command that always errors — and omitting it from
    // claude-agent-sdk (as this table used to) rejected one that always works.
    expect(RUNTIME_CAPABILITIES["claude-agent-sdk"]).toContain("steer")
    expect(RUNTIME_CAPABILITIES["external"]).toContain("steer")
    expect(RUNTIME_CAPABILITIES["ai-sdk"]).not.toContain("steer")
  })

  it("never claims a capability the runtime has not actually implemented", () => {
    // The 16 SDK-parity ids exist in the vocabulary from contract v2, but a
    // runtime table entry is a claim that code exists. Each id joins its
    // adapter's list only when the corresponding stage lands; listing them
    // early is the "built but dormant" failure this repo keeps hitting.
    //
    // Shrinking this list is how a stage records that it finished. What is
    // left is the two callback surfaces the sidecar does not build yet
    // (`onElicitation` / `onUserDialog`).
    const allTabled = new Set(Object.values(RUNTIME_CAPABILITIES).flat())
    for (const notYetImplemented of ["input.elicitation", "input.dialog"]) {
      expect(allTabled.has(notYetImplemented as never)).toBe(false)
    }
  })

  it("claims the Stage 3 capabilities on the claude rail only", () => {
    // The other half of the pin above: a capability that IS implemented must
    // be claimed, or the fail-closed gate rejects a session that can serve the
    // call. That was the `steer` bug, and every control added in Stage 3 is a
    // fresh chance to repeat it.
    for (const implemented of [
      "commands.dynamic",
      "session.manage",
      "plugins.native",
      "skills.native",
      "checkpoint",
      "mcp.dynamic",
      "subagents.manage",
      "tasks.background",
      "output.structured",
      "sandbox.native",
      "hooks.lifecycle",
      "permissions.update-rules",
      "observability.child",
      "session.store",
      "startup.prewarm",
    ] as const) {
      expect(RUNTIME_CAPABILITIES["claude-agent-sdk"]).toContain(implemented)
      // These are Claude Agent SDK surfaces. The ai-sdk rail has no `Query`
      // object at all, so claiming any of them there would promise a control
      // that can only fail.
      expect(RUNTIME_CAPABILITIES["ai-sdk"]).not.toContain(implemented)
    }
  })
})

describe("contract v2 capability verdicts", () => {
  it("emits specVersion 2 with a native verdict for every effective capability", () => {
    const { spec } = resolveAgentExecutionSpec(baseInput())
    expect(spec.specVersion).toBe(2)

    const support = spec.capabilities.support ?? {}
    for (const cap of spec.capabilities.effective) {
      expect(support[cap]).toEqual({ support: "native" })
    }
    expect(validateResolvedAgentExecutionSpec(spec).ok).toBe(true)
  })

  it("records an asked-for capability the runtime lacks as unsupported, with the reason", () => {
    const { spec } = resolveAgentExecutionSpec(
      baseInput({
        policy: {
          executionKind: "agent",
          runtimePolicy: "claude-agent-sdk",
          routePolicy: "direct",
          // Derived, not hardcoded: naming a specific id here means the test
          // quietly stops testing refusal the day that id becomes supported.
          prefers: [UNSERVED_BY_CLAUDE],
          fallbackPolicy: "none",
        },
      })
    )

    expect(spec.capabilities.support?.[UNSERVED_BY_CLAUDE]).toEqual({
      support: "unsupported",
      reason: `runtime adapter "claude-agent-sdk" does not implement "${UNSERVED_BY_CLAUDE}"`,
    })
    expect(validateResolvedAgentExecutionSpec(spec).ok).toBe(true)
  })
})

describe("negotiated external capability profile", () => {
  /**
   * A capability the external FAMILY FALLBACK does not list. Derived rather
   * than written down: these tests exist to prove a negotiated profile
   * REPLACES that list, and a hardcoded id would stop proving it the day the
   * fallback grows.
   */
  const BEYOND_THE_FALLBACK = (() => {
    const fallback = new Set(RUNTIME_CAPABILITIES.external)
    const id = AGENT_CAPABILITY_IDS.find((c) => !fallback.has(c))
    if (!id) throw new Error("the external fallback now lists everything — pick a new probe")
    return id
  })()

  const teammate = { surface: "team" as const, legacy: { runtime: "codex" } }

  function profile(
    overrides: Partial<NonNullable<AgentExecutionResolveInput["externalCapabilities"]>> = {}
  ) {
    return {
      effective: ["streaming", BEYOND_THE_FALLBACK] as AgentCapabilityId[],
      support: {} as NonNullable<AgentExecutionResolveInput["externalCapabilities"]>["support"],
      profileDigest: "eacp1-0123456789abcdef",
      negotiated: true,
      ...overrides,
    }
  }

  it("replaces the family fallback with what this agent actually answered", () => {
    const { spec } = resolveAgentExecutionSpec(
      baseInput({ ...teammate, externalCapabilities: profile() })
    )

    expect(spec.runtimeAdapter).toBe("external")
    expect(spec.capabilities.effective).toEqual(["streaming", BEYOND_THE_FALLBACK])
    // Not intersected with the fallback: the profile has already applied the
    // agent's own ceilings, and intersecting would strip capabilities this
    // particular agent demonstrably has.
    for (const cap of RUNTIME_CAPABILITIES.external) {
      if (cap === "streaming") continue
      expect(spec.capabilities.effective).not.toContain(cap)
    }
  })

  it("traces the run back to the capability answer it was frozen against", () => {
    const { spec } = resolveAgentExecutionSpec(
      baseInput({ ...teammate, externalCapabilities: profile() })
    )

    // An external agent is never native to Cognia's own rail, and the digest
    // is the whole reason the profile has one.
    expect(spec.compatibility).toEqual({
      evidence: "experimental",
      recordRef: "eacp1-0123456789abcdef",
    })
    expect(validateResolvedAgentExecutionSpec(spec).ok).toBe(true)
  })

  it("refuses a profile built before the handshake", () => {
    // This is the whole point of two-phase admission: a pre-handshake profile
    // describes what we hoped for, and freezing a spec from it is the failure
    // the split exists to prevent. It is dropped HERE so no caller can opt out.
    const { spec } = resolveAgentExecutionSpec(
      baseInput({ ...teammate, externalCapabilities: profile({ negotiated: false }) })
    )

    expect(spec.capabilities.effective).toEqual([...RUNTIME_CAPABILITIES.external])
    expect(spec.compatibility).toEqual({ evidence: "native" })
  })

  it("ignores a profile when the resolved adapter is not external", () => {
    // A capability profile cannot make the claude-agent-sdk rail behave
    // differently, so a stale one riding along must not widen it.
    const { spec } = resolveAgentExecutionSpec(
      baseInput({
        legacy: { providerId: "anthropic", toolsEnabled: true },
        externalCapabilities: profile(),
      })
    )

    expect(spec.runtimeAdapter).toBe("claude-agent-sdk")
    expect(spec.capabilities.effective).toEqual([...RUNTIME_CAPABILITIES["claude-agent-sdk"]])
    expect(spec.compatibility).toEqual({ evidence: "native" })
  })

  it("keeps the profile's own reason instead of an anonymous refusal", () => {
    const { spec, missingRequired } = resolveAgentExecutionSpec(
      baseInput({
        ...teammate,
        externalCapabilities: profile({
          support: {
            mcp: { support: "unsupported", reason: "this protocol cannot carry an MCP server" },
          },
        }),
        policy: {
          executionKind: "agent",
          runtimePolicy: "auto",
          routePolicy: "direct",
          requires: ["mcp"],
        },
      })
    )

    expect(missingRequired).toEqual(["mcp"])
    // Regenerating verdicts from `effective` would flatten "the handshake said
    // no" and "nobody ever measured this" into the same empty `unsupported`.
    expect(spec.capabilities.support?.mcp).toEqual({
      support: "unsupported",
      reason: "this protocol cannot carry an MCP server",
    })
  })

  it("still clamps a negotiated profile to what the host backend can serve", () => {
    // The profile carries the AGENT's ceilings, not the host's. A headless
    // host that cannot stream does not gain streaming because the agent can.
    const { spec } = resolveAgentExecutionSpec(
      baseInput({
        ...teammate,
        environment: { ...headless, hostCapabilities: [BEYOND_THE_FALLBACK] },
        externalCapabilities: profile(),
      })
    )

    expect(spec.capabilities.effective).toEqual([BEYOND_THE_FALLBACK])
  })
})
