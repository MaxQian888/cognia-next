/** @jest-environment jsdom */
import type { AgentExecutionFlag } from "./feature-flags"
import { resolveAgentExecutionSpec } from "./resolve-agent-execution-spec"

const trackEventMock = jest.fn().mockResolvedValue(true)
jest.mock("@/lib/telemetry/events/track-event", () => ({
  trackEvent: (...args: unknown[]) => trackEventMock(...args),
}))

import { __clearShadowDecisions, getShadowDecisions, recordShadowDecision } from "./shadow-recorder"

const flagsOn: Record<AgentExecutionFlag, boolean> = {
  agentExecutionResolverV2: true,
  genericAgentHostCommands: false,
  gatewayAgentRouteTickets: false,
  headlessLlmGateway: false,
  experimentalAnthropicDeploymentAgentSdk: false,
}

const desktop = { isTauri: true, isHeadlessHost: false }

function resolution(overrides: { providerId?: string; toolsEnabled?: boolean } = {}) {
  return resolveAgentExecutionSpec({
    surface: "agent-executor",
    environment: desktop,
    flags: flagsOn,
    legacy: {
      providerId: overrides.providerId ?? "anthropic",
      toolsEnabled: overrides.toolsEnabled ?? true,
      requireTools: true,
    },
    identity: { sessionId: "s1" },
    now: "2026-07-23T00:00:00.000Z",
  })
}

function enableShadowFlag() {
  window.localStorage.setItem(
    "cognia-agent-execution-flags-v1",
    JSON.stringify({ agentExecutionResolverV2: true })
  )
}

describe("recordShadowDecision", () => {
  beforeEach(() => {
    __clearShadowDecisions()
    trackEventMock.mockClear()
    window.localStorage.clear()
  })

  it("is a no-op while the resolver flag is off", () => {
    recordShadowDecision({
      resolution: resolution(),
      environment: desktop,
      legacyChannel: "text",
    })
    expect(getShadowDecisions()).toHaveLength(0)
    expect(trackEventMock).not.toHaveBeenCalled()
  })

  it("records agreement without emitting divergence telemetry", () => {
    enableShadowFlag()
    recordShadowDecision({
      resolution: resolution(),
      environment: desktop,
      legacyChannel: "sidecar",
    })
    const records = getShadowDecisions()
    expect(records).toHaveLength(1)
    expect(records[0].resolvedChannel).toBe("sidecar")
    expect(records[0].trace.divergence).toEqual([])
    expect(trackEventMock).not.toHaveBeenCalled()
  })

  it("emits enum-only divergence telemetry when channels disagree", () => {
    enableShadowFlag()
    recordShadowDecision({
      resolution: resolution(),
      environment: desktop,
      legacyChannel: "text",
    })
    expect(trackEventMock).toHaveBeenCalledTimes(1)
    const [name, attributes] = trackEventMock.mock.calls[0]
    expect(name).toBe("agent.execution.shadow_divergence")
    expect(attributes).toMatchObject({
      surface: "agent-executor",
      oldChannel: "text",
      newRuntime: "claude-agent-sdk",
      newRouteKind: "direct",
    })
    expect(attributes.divergence).toContain("runtime")
  })

  it("caps the ring buffer at 64 entries, newest last", () => {
    enableShadowFlag()
    for (let i = 0; i < 70; i += 1) {
      recordShadowDecision({
        resolution: resolution(),
        environment: desktop,
        legacyChannel: "sidecar",
      })
    }
    expect(getShadowDecisions()).toHaveLength(64)
  })

  it("never stores secret-shaped strings even for adversarial inputs", () => {
    enableShadowFlag()
    recordShadowDecision({
      resolution: resolveAgentExecutionSpec({
        surface: "chat",
        environment: desktop,
        flags: flagsOn,
        legacy: { providerId: "custom-x", modelId: "m-1", toolsEnabled: true },
        policy: { credentialProfileRef: "cp-1" },
        now: "2026-07-23T00:00:00.000Z",
      }),
      environment: desktop,
      legacyChannel: "sidecar",
    })
    const serialized = JSON.stringify(getShadowDecisions())
    expect(serialized).not.toMatch(/sk-[a-zA-Z0-9]/)
    expect(serialized.toLowerCase()).not.toMatch(/api[_-]?key|bearer|token/)
  })

  it("flags a kind divergence when a sidecar legacy run resolves to completion", () => {
    enableShadowFlag()
    recordShadowDecision({
      resolution: resolution({ toolsEnabled: false }),
      environment: desktop,
      legacyChannel: "sidecar",
    })
    const [record] = getShadowDecisions()
    expect(record.resolvedChannel).toBe("text")
    expect(record.trace.divergence).toEqual(expect.arrayContaining(["runtime", "kind"]))
  })

  it("flags a kind divergence when a text legacy run resolves to agent", () => {
    enableShadowFlag()
    recordShadowDecision({
      resolution: resolution(),
      environment: desktop,
      legacyChannel: "text",
    })
    const [record] = getShadowDecisions()
    expect(record.trace.divergence).toEqual(expect.arrayContaining(["runtime", "kind"]))
  })

  it("records without divergence when the legacy channel is unknown", () => {
    enableShadowFlag()
    recordShadowDecision({
      resolution: resolution(),
      environment: desktop,
    })
    const [record] = getShadowDecisions()
    expect(record.legacyChannel).toBeUndefined()
    expect(record.trace.divergence).toEqual([])
    expect(trackEventMock).not.toHaveBeenCalled()
  })

  it("reports a route divergence with oldChannel 'unknown' when legacy channel is absent", () => {
    enableShadowFlag()
    recordShadowDecision({
      resolution: resolveAgentExecutionSpec({
        surface: "chat",
        environment: desktop,
        flags: { ...flagsOn, gatewayAgentRouteTickets: true },
        legacy: { providerId: "anthropic", proxyMode: "always", toolsEnabled: true },
        now: "2026-07-23T00:00:00.000Z",
      }),
      environment: desktop,
    })
    expect(trackEventMock).toHaveBeenCalledTimes(1)
    const [, attributes] = trackEventMock.mock.calls[0]
    expect(attributes.oldChannel).toBe("unknown")
    expect(attributes.divergence).toContain("route")
  })

  it("survives a rejected telemetry promise", () => {
    enableShadowFlag()
    trackEventMock.mockRejectedValueOnce(new Error("export failed"))
    expect(() =>
      recordShadowDecision({
        resolution: resolution(),
        environment: desktop,
        legacyChannel: "text",
      })
    ).not.toThrow()
  })

  it("swallows internal failures instead of affecting the caller", () => {
    enableShadowFlag()
    trackEventMock.mockImplementationOnce(() => {
      throw new Error("telemetry down")
    })
    expect(() =>
      recordShadowDecision({
        resolution: resolution(),
        environment: desktop,
        legacyChannel: "text",
      })
    ).not.toThrow()
  })
})
