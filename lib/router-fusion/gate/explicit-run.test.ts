import type { AppSettings } from "@cognia/agent-config-types"
import { EDITABLE_ACTION_MODES } from "@cognia/router-fusion/settings/action-catalog"
import { EXECUTABLE_MODES } from "@/lib/router-fusion/api/run-api"

import { __resetBreakerForTesting, recordFusionFault } from "./breaker"
import { RouterFusionInfrastructureError, RouterFusionRefusalError } from "./faults"
import {
  __resetFusionScopesForTesting,
  FUSION_ACTION_CHOICES,
  fusionActionAvailability,
  fusionActionChoiceOf,
  fusionActionRequested,
  fusionAncestorActive,
  isFusionActionChoice,
  isWiredFusionActionMode,
  runExplicitAgentFusionTurn,
  validateFusionActionChoice,
  WIRED_FUSION_ACTION_MODES,
  type ExplicitFusionTurnInput,
} from "./explicit-run"
import type { RouterFusionHost } from "./load-engine"

const ON = {
  routerFusion: { enabled: true, surfaces: { agentsWorkflows: true } },
} as unknown as AppSettings
const OFF = {
  routerFusion: { enabled: true, surfaces: { agentsWorkflows: false } },
} as unknown as AppSettings

const ANSWER = {
  kind: "answered" as const,
  runId: "run-1",
  mode: "panel" as const,
  text: "checked",
  qualityStatus: "accepted" as const,
  usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 },
  spentMicrousd: 1234,
  modelCalls: 3,
  warnings: [],
}

function hostWith(run: (input: unknown) => Promise<unknown>): () => Promise<RouterFusionHost> {
  return async () => ({ runAgentsWorkflowsFusion: run }) as unknown as RouterFusionHost
}

function turn(overrides: Partial<ExplicitFusionTurnInput> = {}): ExplicitFusionTurnInput {
  return {
    mode: "panel",
    origin: "agent",
    featureId: "teammate:tm1",
    messages: [{ role: "user", content: "compare the two tariffs" }],
    settings: ON,
    loadHost: hostWith(async () => ANSWER),
    ...overrides,
  }
}

beforeEach(() => {
  __resetBreakerForTesting()
  __resetFusionScopesForTesting()
})

describe("action choices", () => {
  it("reads any stored value back as a choice, defaulting to auto", () => {
    expect(fusionActionChoiceOf("cascade")).toBe("cascade")
    expect(fusionActionChoiceOf("nonsense")).toBe("auto")
    expect(fusionActionChoiceOf(undefined)).toBe("auto")
    expect(isFusionActionChoice("panel")).toBe(true)
    expect(isFusionActionChoice("Panel")).toBe(false)
    expect(fusionActionRequested("auto")).toBe(false)
    expect(fusionActionRequested(undefined)).toBe(false)
    expect(fusionActionRequested("direct")).toBe(true)
  })

  /**
   * Rule 7, axis 3. The authority is what this build EXECUTES, not what its
   * action catalog lets a person edit: a mode the Run API's `EXECUTABLE_MODES`
   * leaves out is filtered away by the router, so a picker offering it would
   * be lying. The gate cannot import the host module, so this pin is what
   * keeps its copy honest — when the two diverge, the constant, the picker's
   * "Later release" label and this test move together.
   */
  it("pins the wired modes against the modes this build executes", () => {
    expect([...WIRED_FUSION_ACTION_MODES]).toEqual([...EXECUTABLE_MODES])
    // B4 shipped delegate: editable in the catalog AND executable here.
    expect(EDITABLE_ACTION_MODES).toContain("delegate")
    expect(isWiredFusionActionMode("delegate")).toBe(true)
    expect(FUSION_ACTION_CHOICES).toContain("delegate")
  })

  it("has nothing dormant left to label", () => {
    expect(fusionActionAvailability(ON).dormant).toEqual([])
  })

  it("offers nothing but auto while the surface is off", () => {
    expect(fusionActionAvailability(OFF)).toEqual({
      surfaceEnabled: false,
      allowed: [],
      dormant: [],
    })
    expect(fusionActionAvailability(ON).allowed).toEqual([...WIRED_FUSION_ACTION_MODES])
  })
})

describe("validateFusionActionChoice", () => {
  it("accepts auto whatever the settings say", () => {
    expect(
      validateFusionActionChoice({ action: "auto", settings: OFF, hasWorkspace: false })
    ).toBeNull()
    expect(
      validateFusionActionChoice({ action: undefined, settings: OFF, hasWorkspace: false })
    ).toBeNull()
  })

  it("refuses a chosen mode the current settings do not allow", () => {
    expect(
      validateFusionActionChoice({ action: "cascade", settings: OFF, hasWorkspace: true })
    ).toBe("surfaceOff")
    expect(
      validateFusionActionChoice({ action: "cascade", settings: ON, hasWorkspace: false })
    ).toBeNull()
  })

  it("refuses delegate without a workspace, and allows it with one", () => {
    expect(
      validateFusionActionChoice({ action: "delegate", settings: ON, hasWorkspace: false })
    ).toBe("workspaceRequired")
    expect(
      validateFusionActionChoice({ action: "delegate", settings: ON, hasWorkspace: true })
    ).toBeNull()
    // Only delegate edits files; the other modes need no workspace at all.
    expect(
      validateFusionActionChoice({ action: "panel", settings: ON, hasWorkspace: false })
    ).toBeNull()
  })

  it("reports a mode this build cannot execute as dormant, not as a bad value", () => {
    // There is none today, so the branch is exercised through the predicate
    // the picker and the executor both read.
    expect(isWiredFusionActionMode("delegate")).toBe(true)
    expect(isWiredFusionActionMode("nonsense")).toBe(false)
  })
})

describe("runExplicitAgentFusionTurn", () => {
  it("[ACC:OFF-AGENTS] skips, and loads nothing, while the surface is off", async () => {
    const loadHost = jest.fn(hostWith(async () => ANSWER))
    const outcome = await runExplicitAgentFusionTurn(turn({ settings: OFF, loadHost }))
    expect(outcome).toEqual({ kind: "skipped" })
    expect(loadHost).not.toHaveBeenCalled()
  })

  it("runs the chosen mode and hands back the run's answer", async () => {
    const seen: unknown[] = []
    const outcome = await runExplicitAgentFusionTurn(
      turn({
        loadHost: hostWith(async (call) => {
          seen.push(call)
          return ANSWER
        }),
      })
    )
    expect(outcome).toMatchObject({ kind: "answered", text: "checked", runId: "run-1" })
    expect(seen[0]).toMatchObject({
      mode: "panel",
      origin: "agent",
      featureId: "teammate:tm1",
      hasFusionAncestor: false,
      jsonSchema: null,
    })
  })

  it("refuses a mode this build cannot execute without loading the engine", async () => {
    const loadHost = jest.fn(hostWith(async () => ANSWER))
    const outcome = await runExplicitAgentFusionTurn(
      // Not a mode any picker can produce; the guard exists for a stored value
      // from a newer build, and for a mode that goes dormant again.
      turn({ mode: "swarm" as never, loadHost })
    )
    expect(outcome).toMatchObject({ kind: "refused", code: "FUSION_MODE_UNAVAILABLE" })
    expect(loadHost).not.toHaveBeenCalled()
  })

  it("runs delegate now that this build executes it", async () => {
    const seen: Array<{ mode?: string }> = []
    const outcome = await runExplicitAgentFusionTurn(
      turn({
        mode: "delegate",
        workspaceId: "project-1",
        loadHost: hostWith(async (call) => {
          seen.push(call as { mode?: string })
          return { ...ANSWER, mode: "delegate" as const }
        }),
      })
    )
    expect(outcome).toMatchObject({ kind: "answered", mode: "delegate" })
    expect(seen[0]?.mode).toBe("delegate")
  })

  it("[ACC:ISO-03] fails explicitly on a tripped surface instead of answering some other way", async () => {
    recordFusionFault("agentsWorkflows", "db_unavailable", 1, Date.now())
    await expect(runExplicitAgentFusionTurn(turn())).rejects.toMatchObject({
      code: "ROUTER_FUSION_UNAVAILABLE",
    })
  })

  it("[ACC:ISO-03] turns an infrastructure fault into ROUTER_FUSION_UNAVAILABLE, never an ordinary turn", async () => {
    await expect(
      runExplicitAgentFusionTurn(
        turn({
          loadHost: async () => {
            throw new RouterFusionInfrastructureError("db_unavailable", "closed")
          },
        })
      )
    ).rejects.toMatchObject({ code: "ROUTER_FUSION_UNAVAILABLE" })
  })

  it("re-raises a refusal untouched: it is an answer, not a fault", async () => {
    await expect(
      runExplicitAgentFusionTurn(
        turn({
          loadHost: hostWith(async () => {
            throw new RouterFusionRefusalError("TENANT_BUDGET_EXHAUSTED", "no budget")
          }),
        })
      )
    ).rejects.toBeInstanceOf(RouterFusionRefusalError)
  })

  it("[ACC:INV-09] marks its scope so a turn started inside it has a fusion ancestor", async () => {
    let nested: boolean | undefined
    const outcome = await runExplicitAgentFusionTurn(
      turn({
        scopeId: "team-run-1",
        loadHost: hostWith(async () => {
          nested = fusionAncestorActive("team-run-1")
          return ANSWER
        }),
      })
    )
    expect(outcome.kind).toBe("answered")
    expect(nested).toBe(true)
    // The mark is released with the turn.
    expect(fusionAncestorActive("team-run-1")).toBe(false)
    expect(fusionAncestorActive(null)).toBe(false)
  })

  it("[ACC:INV-09] passes the ancestor flag through to the router", async () => {
    const seen: Array<{ hasFusionAncestor?: boolean }> = []
    const inner = hostWith(async (call) => {
      seen.push(call as { hasFusionAncestor?: boolean })
      return ANSWER
    })
    await runExplicitAgentFusionTurn(
      turn({
        scopeId: "run-a",
        loadHost: hostWith(async () => {
          await runExplicitAgentFusionTurn(turn({ scopeId: "run-a", loadHost: inner }))
          return ANSWER
        }),
      })
    )
    expect(seen[0]?.hasFusionAncestor).toBe(true)
  })

  it("lets a caller force the ancestor flag", async () => {
    const seen: Array<{ hasFusionAncestor?: boolean }> = []
    await runExplicitAgentFusionTurn(
      turn({
        hasFusionAncestor: true,
        loadHost: hostWith(async (call) => {
          seen.push(call as { hasFusionAncestor?: boolean })
          return ANSWER
        }),
      })
    )
    expect(seen[0]?.hasFusionAncestor).toBe(true)
  })
})
