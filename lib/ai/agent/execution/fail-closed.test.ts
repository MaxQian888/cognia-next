// Fail-closed guarantees (ADR-0090 Phase 4 acceptance).
//
// The resolver outputs that FORCE downstream fail-before-spend behavior:
// hard-capability gaps, gateway-required routing, and the frozen-model rule.
// The gateway-side halves (invalid/expired tickets, unmapped selectors,
// candidate freezing) are proven end-to-end in
// crates/cognia-gateway/tests/phase2_gateway.rs and
// tests/conformance/cases/vertical-slice.test.mjs.

import type { AgentExecutionFlag } from "./feature-flags"
import { createAgentExecutionHandle, FrozenModelBindingError } from "./agent-execution-handle"
import { resolveAgentExecutionSpec } from "./resolve-agent-execution-spec"

const flags: Record<AgentExecutionFlag, boolean> = {
  agentTeamRemoteDispatch: false,
  genericAgentHostCommands: true,
  gatewayAgentRouteTickets: true,
  headlessLlmGateway: false,
  experimentalAnthropicDeploymentAgentSdk: true,
  claudeSdkParityV1: false,
  claudeSdkSessionStore: false,
  claudeSdkCheckpoint: false,
  claudeSdkPrewarm: false,
}

describe("fail-closed resolver outputs", () => {
  it("a hard capability the runtime lacks is reported for fail-before-spend", () => {
    const resolution = resolveAgentExecutionSpec({
      surface: "agent-executor",
      environment: { isTauri: true, isHeadlessHost: false },
      flags,
      policy: {
        executionKind: "agent",
        runtimePolicy: "ai-sdk",
        routePolicy: "gateway-required",
        requires: ["subagents.native"],
      },
    })
    expect(resolution.missingRequired).toEqual(["subagents.native"])
    // The spec itself never silently downgrades the request.
    expect(resolution.spec.executionKind).toBe("agent")
    expect(resolution.spec.fallbackPolicy).toBe("none")
  })

  it("gateway-required + tickets flag pins the route to the gateway (no direct expression)", () => {
    const resolution = resolveAgentExecutionSpec({
      surface: "chat",
      environment: { isTauri: true, isHeadlessHost: false },
      flags,
      policy: {
        executionKind: "agent",
        runtimePolicy: "claude-agent-sdk",
        routePolicy: "gateway-required",
        deploymentRef: "my-custom-anthropic",
      },
    })
    expect(resolution.spec.route.kind).toBe("gateway")
    expect(resolution.spec.route.routePolicy).toBe("gateway-required")
  })

  it("experimental opt-in resolves as explicit policy, never as auto evidence", () => {
    const resolution = resolveAgentExecutionSpec({
      surface: "chat",
      environment: { isTauri: true, isHeadlessHost: false },
      flags,
      policy: {
        executionKind: "agent",
        runtimePolicy: "claude-agent-sdk",
        routePolicy: "gateway-required",
      },
      legacy: { providerId: "my-custom-anthropic" },
    })
    expect(resolution.spec.runtimePolicySource).toBe("explicit")
    // Without the explicit policy the same provider id resolves to ai-sdk —
    // the opt-in never leaks into `auto` (R5).
    const auto = resolveAgentExecutionSpec({
      surface: "chat",
      environment: { isTauri: true, isHeadlessHost: false },
      flags,
      legacy: { providerId: "my-custom-anthropic" },
    })
    expect(auto.spec.runtimeAdapter).toBe("ai-sdk")
  })

  it("an unbound model selector is rejected at the handle before any IPC", async () => {
    const resolution = resolveAgentExecutionSpec({
      surface: "chat",
      environment: { isTauri: true, isHeadlessHost: false },
      flags,
      policy: {
        executionKind: "agent",
        runtimePolicy: "claude-agent-sdk",
        routePolicy: "gateway-required",
      },
      legacy: { modelId: "claude-opus-4-8" },
    })
    const setSessionModel = jest.fn()
    const handle = createAgentExecutionHandle("s1", resolution.spec, {
      ipc: { setSessionModel } as never,
    })
    await expect(handle.setModel("gpt-4o")).rejects.toThrow(FrozenModelBindingError)
    expect(setSessionModel).not.toHaveBeenCalled()
  })
})
