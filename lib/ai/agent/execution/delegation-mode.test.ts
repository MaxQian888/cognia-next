import type { AgentExecutionFlag } from "./feature-flags"
import { decideDelegationMode } from "./delegation-mode"
import { resolveAgentExecutionSpec } from "./resolve-agent-execution-spec"

const flags: Record<AgentExecutionFlag, boolean> = {
  agentExecutionResolverV2: true,
  genericAgentHostCommands: false,
  gatewayAgentRouteTickets: false,
  headlessLlmGateway: false,
  experimentalAnthropicDeploymentAgentSdk: false,
}

const desktop = { isTauri: true, isHeadlessHost: false }

function spec(
  overrides: Parameters<typeof resolveAgentExecutionSpec>[0]["legacy"] = {},
  policy = {}
) {
  return resolveAgentExecutionSpec({
    surface: "team",
    environment: desktop,
    flags,
    legacy: { providerId: "anthropic", toolsEnabled: true, ...overrides },
    policy,
    now: "2026-07-23T00:00:00.000Z",
  }).spec
}

describe("decideDelegationMode", () => {
  it("same runtime/route/host with only a model-binding difference is NATIVE", () => {
    const parent = spec({ modelId: "claude-opus-4-8" })
    const child = spec({ modelId: "claude-haiku-4-5-20251001" })
    expect(decideDelegationMode(parent, child)).toEqual({ mode: "native", reasons: [] })
  })

  it("a different runtime forces orchestrated with a machine-readable reason", () => {
    const parent = spec()
    const child = spec({ providerId: "openai" }) // legacy-maps to ai-sdk
    const decision = decideDelegationMode(parent, child)
    expect(decision.mode).toBe("orchestrated")
    expect(decision.reasons).toContain("runtime-differs")
  })

  it("a different host pin forces orchestrated", () => {
    const parent = spec()
    const child = resolveAgentExecutionSpec({
      surface: "team",
      environment: desktop,
      flags,
      legacy: { providerId: "anthropic", toolsEnabled: true },
      policy: { executionTarget: { mode: "pinned", hostRef: "remote-host-2" } },
      now: "2026-07-23T00:00:00.000Z",
    }).spec
    const decision = decideDelegationMode(parent, child)
    expect(decision.mode).toBe("orchestrated")
    expect(decision.reasons).toContain("host-differs")
  })

  it("a different deployment or credential reference forces orchestrated", () => {
    const parent = spec()
    const byDeployment = resolveAgentExecutionSpec({
      surface: "team",
      environment: desktop,
      flags,
      legacy: { providerId: "anthropic", toolsEnabled: true },
      policy: { deploymentRef: "dep-vendor-b" },
      now: "2026-07-23T00:00:00.000Z",
    }).spec
    expect(decideDelegationMode(parent, byDeployment).reasons).toContain("deployment-differs")

    const byCredential = resolveAgentExecutionSpec({
      surface: "team",
      environment: desktop,
      flags,
      legacy: { providerId: "anthropic", toolsEnabled: true },
      policy: { credentialProfileRef: "cred-2" },
      now: "2026-07-23T00:00:00.000Z",
    }).spec
    expect(decideDelegationMode(parent, byCredential).reasons).toContain("credential-differs")
  })

  it("a hard capability the parent cannot serve forces orchestrated", () => {
    const parent = spec()
    // The external runtime's effective set includes "steer", which the parent
    // (claude-agent-sdk) does not serve.
    const child = resolveAgentExecutionSpec({
      surface: "team",
      environment: desktop,
      flags,
      legacy: { runtime: "codex", toolsEnabled: true },
      now: "2026-07-23T00:00:00.000Z",
    }).spec
    const decision = decideDelegationMode(parent, child)
    expect(decision.mode).toBe("orchestrated")
    expect(decision.reasons).toEqual(
      expect.arrayContaining(["runtime-differs", "capability-differs"])
    )
  })

  it("identical pinned credentials on both sides stay native", () => {
    const withCred = resolveAgentExecutionSpec({
      surface: "team",
      environment: desktop,
      flags,
      legacy: { providerId: "anthropic", toolsEnabled: true },
      policy: { credentialProfileRef: "cred-1" },
      now: "2026-07-23T00:00:00.000Z",
    }).spec
    expect(decideDelegationMode(withCred, withCred).mode).toBe("native")
  })

  it("reasons are empty exactly when native", () => {
    const parent = spec()
    const native = decideDelegationMode(parent, parent)
    expect(native.mode).toBe("native")
    expect(native.reasons).toHaveLength(0)
  })
})
