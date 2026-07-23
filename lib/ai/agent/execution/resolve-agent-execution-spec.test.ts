import { validateResolvedAgentExecutionSpec } from "@cognia/agent-config-types/agent-execution"

import type { AgentExecutionFlag } from "./feature-flags"
import {
  channelFromSpec,
  resolveAgentExecutionSpec,
  RUNTIME_CAPABILITIES,
  sendSpecFromResolved,
  type AgentExecutionResolveInput,
} from "./resolve-agent-execution-spec"

const flagsOff: Record<AgentExecutionFlag, boolean> = {
  agentExecutionResolverV2: false,
  genericAgentHostCommands: false,
  gatewayAgentRouteTickets: false,
  headlessLlmGateway: false,
  experimentalAnthropicDeploymentAgentSdk: false,
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
        specVersion: 1,
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
  it("only claude-agent-sdk offers native subagents; only external offers steer", () => {
    expect(RUNTIME_CAPABILITIES["claude-agent-sdk"]).toContain("subagents.native")
    expect(RUNTIME_CAPABILITIES["ai-sdk"]).not.toContain("subagents.native")
    expect(RUNTIME_CAPABILITIES["external"]).toContain("steer")
    expect(RUNTIME_CAPABILITIES["claude-agent-sdk"]).not.toContain("steer")
  })
})
