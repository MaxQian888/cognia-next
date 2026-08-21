import { AGENT_CAPABILITY_IDS } from "@cognia/agent-config-types/agent-execution"

import type { AgentExecutionFlag } from "./feature-flags"
import { decideDelegationMode } from "./delegation-mode"
import { RUNTIME_CAPABILITIES, resolveAgentExecutionSpec } from "./resolve-agent-execution-spec"

/**
 * A capability the claude rail genuinely does not serve, derived from the table
 * rather than written down.
 *
 * Hardcoding one is how this test twice ended up asserting nothing: first with
 * `steer` (which the rail had all along) and then with `session.store` (which
 * it gained in Stage 4). Both times the injected "extra" was already in the
 * parent's set, so the delegation check had nothing to reject.
 */
const UNSERVED_BY_PARENT = (() => {
  const served = new Set(RUNTIME_CAPABILITIES["claude-agent-sdk"])
  const id = AGENT_CAPABILITY_IDS.find((c) => !served.has(c))
  if (!id) throw new Error("claude-agent-sdk now serves every capability — pick a new probe")
  return id
})()

const flags: Record<AgentExecutionFlag, boolean> = {
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
    // The child's extra capability is DERIVED (see UNSERVED_BY_PARENT), not
    // written down: every hardcoded probe here has eventually been added to
    // the claude rail, at which point the test kept passing while asserting
    // nothing.
    const runtimeDiffers = resolveAgentExecutionSpec({
      surface: "team",
      environment: desktop,
      flags,
      legacy: { runtime: "codex", toolsEnabled: true },
      now: "2026-07-23T00:00:00.000Z",
    }).spec
    const child = {
      ...runtimeDiffers,
      capabilities: {
        ...runtimeDiffers.capabilities,
        effective: [...runtimeDiffers.capabilities.effective, UNSERVED_BY_PARENT],
      },
    }

    const decision = decideDelegationMode(parent, child)
    expect(decision.mode).toBe("orchestrated")
    expect(decision.reasons).toEqual(
      expect.arrayContaining(["runtime-differs", "capability-differs"])
    )
  })

  it("a child whose capabilities are a subset of the parent's stays native on that axis", () => {
    const parent = spec()
    const child = {
      ...parent,
      capabilities: { ...parent.capabilities, effective: ["streaming" as const] },
    }
    expect(decideDelegationMode(parent, child).reasons).not.toContain("capability-differs")
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
