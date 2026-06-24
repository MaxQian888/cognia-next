/**
 * Delegation orchestrator tests.
 *
 * Mocks the plugin hooks + executeAgent + background-agent manager so we
 * can drive the orchestrator without spinning the AI provider runtime.
 * Asserts the full lifecycle: create → start hook → settle → complete hook,
 * plus cancellation and approval branches.
 */

import "fake-indexeddb/auto"

const dispatchOnTeamDelegationStart = jest.fn()
const dispatchOnTeamDelegationComplete = jest.fn()

jest.mock("@/lib/plugin/messaging/hooks-system", () => ({
  getPluginLifecycleHooks: jest.fn(() => ({
    dispatchOnTeamDelegationStart,
    dispatchOnTeamDelegationComplete,
  })),
}))

jest.mock("@/lib/ai/agent/background-agent-manager", () => {
  const registerAgent = jest.fn()
  const cancelAgent = jest.fn()
  const finishAgent = jest.fn()
  return {
    __mocks: { registerAgent, cancelAgent, finishAgent },
    getBackgroundAgentManager: jest.fn(() => ({
      registerAgent,
      cancelAgent,
      finishAgent,
    })),
    __resetBackgroundAgentManagerForTesting: jest.fn(),
  }
})

jest.mock("@/lib/ai/agent/agent-executor", () => ({
  executeAgent: jest.fn(),
}))

const externalExecuteMock = jest.fn()
jest.mock("@/lib/ai/agent/external/manager", () => ({
  getExternalAgentManager: jest.fn(() => ({ execute: externalExecuteMock })),
}))

jest.mock("@/lib/connectors/outbound-runner", () => ({
  isInQuietHours: jest.fn(() => false),
}))
import { isInQuietHours } from "@/lib/connectors/outbound-runner"
const isInQuietHoursMock = isInQuietHours as unknown as jest.Mock

const teamStartMock = jest.fn()
const teamGetMock = jest.fn()
jest.mock("@/lib/ai/agent/agent-team", () => ({
  agentTeamManager: {
    start: (...a: unknown[]) => teamStartMock(...a),
    get: (...a: unknown[]) => teamGetMock(...a),
  },
}))
const abortTeamMock = jest.fn()
jest.mock("@/lib/ai/agent/agent-team-runtime", () => ({
  abortTeam: (...a: unknown[]) => abortTeamMock(...a),
}))

import * as bgManagerModule from "@/lib/ai/agent/background-agent-manager"
import { executeAgent } from "@/lib/ai/agent/agent-executor"
const {
  registerAgent: registerAgentMock,
  cancelAgent: cancelAgentMock,
  finishAgent: finishAgentMock,
} = (
  bgManagerModule as unknown as {
    __mocks: { registerAgent: jest.Mock; cancelAgent: jest.Mock; finishAgent: jest.Mock }
  }
).__mocks
const executeAgentMock = executeAgent as unknown as jest.Mock

import {
  __resetPendingDelegationRunsForTesting,
  approveDelegation,
  cancelDelegation,
  completeExternalDelegation,
  delegateToBackground,
  delegateToExternal,
  delegateToTeam,
  wouldCreateTeamCycle,
} from "./delegation-orchestrator"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import type { AgentTeam } from "@/types/agent/agent-team"

/** Flush pending microtasks + a macrotask so async re-dispatch settles. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("delegation-orchestrator", () => {
  beforeEach(() => {
    useAgentTeamStore.getState().reset()
    __resetPendingDelegationRunsForTesting()
    dispatchOnTeamDelegationStart.mockReset()
    dispatchOnTeamDelegationComplete.mockReset()
    registerAgentMock.mockReset()
    cancelAgentMock.mockReset()
    finishAgentMock.mockReset()
    executeAgentMock.mockReset()
    externalExecuteMock.mockReset()
    registerAgentMock.mockImplementation(() => {
      const controller = new AbortController()
      return controller.signal
    })
    executeAgentMock.mockResolvedValue({ text: "ok" })
    externalExecuteMock.mockResolvedValue({ success: true, finalResponse: "external result" })
    isInQuietHoursMock.mockReturnValue(false)
  })

  describe("delegateToBackground", () => {
    it("creates an active delegation and fires onTeamDelegationStart", async () => {
      const { delegation } = delegateToBackground({
        sourceTeamId: "team-1",
        sourceTaskId: "task-1",
        prompt: "Investigate",
        reason: "Investigate offline",
      })
      expect(delegation.status).toBe("active")
      expect(delegation.targetType).toBe("background")
      expect(delegation.targetId).toMatch(/^bg_/)
      expect(useAgentTeamStore.getState().delegations[delegation.id]).toBeDefined()
      expect(dispatchOnTeamDelegationStart).toHaveBeenCalledWith(
        expect.objectContaining({
          delegationId: delegation.id,
          sourceTeamId: "team-1",
          sourceTaskId: "task-1",
          targetType: "background",
        })
      )
    })

    it("dispatches executeAgent and settles to completed on success", async () => {
      executeAgentMock.mockResolvedValue({ text: "background result" })
      const { delegation, completionPromise } = delegateToBackground({
        sourceTeamId: "team-1",
        sourceTaskId: "task-1",
        prompt: "Investigate",
        reason: "offline",
      })
      const settled = await completionPromise
      expect(executeAgentMock).toHaveBeenCalled()
      expect(settled.status).toBe("completed")
      expect(settled.result).toBe("background result")
      expect(finishAgentMock).toHaveBeenCalled()
      expect(dispatchOnTeamDelegationComplete).toHaveBeenCalledWith({
        delegationId: delegation.id,
        status: "completed",
      })
    })

    it("settles to failed when executeAgent throws", async () => {
      executeAgentMock.mockRejectedValue(new Error("boom"))
      const { delegation, completionPromise } = delegateToBackground({
        sourceTeamId: "team-1",
        sourceTaskId: "task-1",
        prompt: "x",
        reason: "y",
      })
      const settled = await completionPromise
      expect(settled.status).toBe("failed")
      expect(settled.result).toBe("boom")
      expect(dispatchOnTeamDelegationComplete).toHaveBeenCalledWith({
        delegationId: delegation.id,
        status: "failed",
      })
    })

    it("respects awaitingApproval and keeps the delegation in that status", async () => {
      const { delegation, completionPromise } = delegateToBackground({
        sourceTeamId: "team-1",
        sourceTaskId: "task-1",
        prompt: "x",
        reason: "needs review",
        awaitingApproval: true,
      })
      expect(delegation.status).toBe("awaiting_approval")
      const settled = await completionPromise
      expect(settled.status).toBe("awaiting_approval")
      expect(executeAgentMock).not.toHaveBeenCalled()
    })
  })

  describe("delegateToExternal", () => {
    it("creates an active sub_agent delegation, fires the start hook, and executes", async () => {
      const { delegation, completionPromise } = delegateToExternal({
        sourceTeamId: "team-1",
        sourceTaskId: "task-1",
        targetAgentId: "claude-code",
        prompt: "do the thing",
        reason: "use external",
      })
      expect(delegation.status).toBe("active")
      expect(delegation.targetType).toBe("sub_agent")
      expect(delegation.targetId).toBe("claude-code")
      expect(dispatchOnTeamDelegationStart).toHaveBeenCalled()
      const settled = await completionPromise
      expect(externalExecuteMock).toHaveBeenCalledWith(
        "claude-code",
        "do the thing",
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      )
      expect(settled.status).toBe("completed")
      expect(settled.result).toBe("external result")
      expect(dispatchOnTeamDelegationComplete).toHaveBeenCalledWith({
        delegationId: delegation.id,
        status: "completed",
      })
    })

    it("settles to failed when the external run returns success=false", async () => {
      externalExecuteMock.mockResolvedValue({ success: false, error: "agent exploded" })
      const { completionPromise } = delegateToExternal({
        sourceTeamId: "team-1",
        sourceTaskId: "task-1",
        targetAgentId: "codex",
        prompt: "x",
        reason: "y",
      })
      const settled = await completionPromise
      expect(settled.status).toBe("failed")
      expect(settled.result).toBe("agent exploded")
    })

    it("settles to timeout when the watchdog fires", async () => {
      externalExecuteMock.mockImplementation(
        (_id: string, _p: string, opts: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            opts.signal.addEventListener("abort", () => reject(new Error("aborted by watchdog")))
          })
      )
      const { completionPromise } = delegateToExternal({
        sourceTeamId: "team-1",
        sourceTaskId: "task-1",
        targetAgentId: "codex",
        prompt: "x",
        reason: "y",
        timeoutMs: 5,
      })
      const settled = await completionPromise
      expect(settled.status).toBe("timeout")
    })

    it("completeExternalDelegation still settles out-of-band runs (manual escape hatch)", () => {
      // Manager hangs → the auto-run never settles; the manual call wins.
      externalExecuteMock.mockReturnValue(new Promise(() => {}))
      const { delegation } = delegateToExternal({
        sourceTeamId: "team-1",
        sourceTaskId: "task-1",
        targetAgentId: "codex",
        prompt: "x",
        reason: "y",
      })
      const settled = completeExternalDelegation(delegation.id, "completed", "manual result")
      expect(settled?.status).toBe("completed")
      expect(settled?.result).toBe("manual result")
      expect(dispatchOnTeamDelegationComplete).toHaveBeenCalledWith({
        delegationId: delegation.id,
        status: "completed",
      })
    })

    it("completeExternalDelegation no-ops for unknown ids", () => {
      const result = completeExternalDelegation("missing", "completed")
      expect(result).toBeUndefined()
    })
  })

  describe("approveDelegation", () => {
    it("flips awaiting_approval to active AND re-dispatches the background run", async () => {
      const { delegation } = delegateToBackground({
        sourceTeamId: "team-1",
        sourceTaskId: "task-1",
        prompt: "investigate later",
        reason: "y",
        awaitingApproval: true,
      })
      expect(executeAgentMock).not.toHaveBeenCalled()
      const after = approveDelegation(delegation.id)
      expect(after?.status).toBe("active")
      await flush()
      expect(executeAgentMock).toHaveBeenCalledWith(
        "investigate later",
        expect.objectContaining({})
      )
      expect(useAgentTeamStore.getState().delegations[delegation.id].status).toBe("completed")
    })

    it("re-dispatches a deferred external run on approval", async () => {
      isInQuietHoursMock.mockReturnValue(true)
      const team = useAgentTeamStore.getState().createTeam({ name: "Quiet", task: "t" })
      useAgentTeamStore.setState((s) => {
        const existing = s.teams[team.id]
        const updated: AgentTeam = {
          ...existing,
          config: {
            ...existing.config,
            // `config.governancePolicy` is optional, so spreading it would
            // widen the required approval/budget/escalation fields to
            // `| undefined`. Provide a complete policy literal instead; the
            // orchestrator only reads `delivery.quietHours`.
            governancePolicy: {
              approval: { requirePlanApproval: false, requireDelegationApproval: false },
              budget: {
                tokenBudget: 0,
                warningThreshold: 0.8,
                criticalThreshold: 0.95,
                onCritical: "notify",
              },
              escalation: { allowOperatorPatternOverride: true, pauseOnHighRisk: false },
              delivery: { quietHours: { from: "00:00", to: "23:59", tz: "UTC" } },
            },
          },
        }
        return { teams: { ...s.teams, [team.id]: updated } }
      })
      const { delegation } = delegateToExternal({
        sourceTeamId: team.id,
        sourceTaskId: "task-q",
        targetAgentId: "claude-code",
        prompt: "handoff payload",
        reason: "handoff",
      })
      expect(delegation.status).toBe("awaiting_approval")
      expect(externalExecuteMock).not.toHaveBeenCalled()
      approveDelegation(delegation.id)
      await flush()
      expect(externalExecuteMock).toHaveBeenCalledWith(
        "claude-code",
        "handoff payload",
        expect.objectContaining({})
      )
      expect(useAgentTeamStore.getState().delegations[delegation.id].status).toBe("completed")
    })

    it("no-ops on non-awaiting delegations", () => {
      const { delegation } = delegateToBackground({
        sourceTeamId: "team-1",
        sourceTaskId: "task-1",
        prompt: "x",
        reason: "y",
        awaitingApproval: true,
      })
      // Approve once (→ active), then approving again is a no-op.
      approveDelegation(delegation.id)
      const after = approveDelegation(delegation.id)
      expect(after?.status).toBe("active")
    })
  })

  describe("cancelDelegation", () => {
    it("flips active background delegation to cancelled and aborts the runtime signal", () => {
      const { delegation } = delegateToBackground({
        sourceTeamId: "team-1",
        sourceTaskId: "task-1",
        prompt: "x",
        reason: "y",
      })
      const after = cancelDelegation(delegation.id)
      expect(after?.status).toBe("cancelled")
      expect(cancelAgentMock).toHaveBeenCalledWith(delegation.targetId)
      expect(dispatchOnTeamDelegationComplete).toHaveBeenCalledWith({
        delegationId: delegation.id,
        status: "cancelled",
      })
    })

    it("no-ops on already-settled delegations", () => {
      externalExecuteMock.mockReturnValue(new Promise(() => {})) // hang so only the manual settle wins
      const { delegation } = delegateToExternal({
        sourceTeamId: "team-1",
        sourceTaskId: "task-1",
        targetAgentId: "x",
        prompt: "p",
        reason: "y",
      })
      completeExternalDelegation(delegation.id, "completed")
      cancelAgentMock.mockReset()
      const after = cancelDelegation(delegation.id)
      expect(after?.status).toBe("completed")
      expect(cancelAgentMock).not.toHaveBeenCalled()
    })

    it("returns undefined for unknown delegationId", () => {
      const after = cancelDelegation("missing")
      expect(after).toBeUndefined()
    })
  })

  describe("quiet-hours gating", () => {
    const seedTeamWithQuietHours = (): string => {
      const team = useAgentTeamStore.getState().createTeam({ name: "Quiet", task: "t" })
      useAgentTeamStore.setState((s) => ({
        teams: {
          ...s.teams,
          [team.id]: {
            ...s.teams[team.id],
            config: {
              ...s.teams[team.id].config,
              governancePolicy: {
                approval: { requirePlanApproval: false, requireDelegationApproval: false },
                budget: {
                  tokenBudget: 0,
                  warningThreshold: 0.8,
                  criticalThreshold: 0.95,
                  onCritical: "notify",
                },
                escalation: { allowOperatorPatternOverride: true, pauseOnHighRisk: false },
                delivery: { quietHours: { from: "00:00", to: "23:59", tz: "UTC" } },
              },
            },
          },
        },
      }))
      return team.id
    }

    it("defers a background delegation to awaiting_approval during quiet hours", async () => {
      isInQuietHoursMock.mockReturnValue(true)
      const teamId = seedTeamWithQuietHours()
      const { delegation, completionPromise } = delegateToBackground({
        sourceTeamId: teamId,
        sourceTaskId: "task-q",
        prompt: "Investigate",
        reason: "offline",
      })
      expect(delegation.status).toBe("awaiting_approval")
      expect(delegation.metadata?.quietHoursDeferred).toBe(true)
      expect(executeAgentMock).not.toHaveBeenCalled()
      await completionPromise
      expect(executeAgentMock).not.toHaveBeenCalled()
    })

    it("force=true launches a background delegation even during quiet hours", async () => {
      isInQuietHoursMock.mockReturnValue(true)
      const teamId = seedTeamWithQuietHours()
      const { delegation, completionPromise } = delegateToBackground({
        sourceTeamId: teamId,
        sourceTaskId: "task-q",
        prompt: "Investigate",
        reason: "offline",
        force: true,
      })
      expect(delegation.status).toBe("active")
      await completionPromise
      expect(executeAgentMock).toHaveBeenCalledTimes(1)
    })

    it("defers an external delegation to awaiting_approval during quiet hours", async () => {
      isInQuietHoursMock.mockReturnValue(true)
      const teamId = seedTeamWithQuietHours()
      const { delegation, completionPromise } = delegateToExternal({
        sourceTeamId: teamId,
        sourceTaskId: "task-q",
        targetAgentId: "claude-code",
        prompt: "handoff payload",
        reason: "handoff",
      })
      expect(delegation.status).toBe("awaiting_approval")
      expect(delegation.metadata?.quietHoursDeferred).toBe(true)
      expect((await completionPromise).status).toBe("awaiting_approval")
      expect(externalExecuteMock).not.toHaveBeenCalled()
    })

    it("does not gate when no quiet-hours policy is configured", async () => {
      isInQuietHoursMock.mockReturnValue(true) // predicate would say yes, but no policy
      const { delegation } = delegateToBackground({
        sourceTeamId: "team-no-policy",
        sourceTaskId: "task-1",
        prompt: "Go",
        reason: "r",
      })
      expect(delegation.status).toBe("active")
    })
  })
})

describe("delegateToTeam (team → team)", () => {
  function seedTeam(id: string, patch: Record<string, unknown> = {}) {
    useAgentTeamStore.setState((s) => ({
      teams: {
        ...s.teams,
        [id]: { id, name: id, teammateIds: [], status: "idle", ...patch } as never,
      },
    }))
  }

  beforeEach(() => {
    useAgentTeamStore.getState().reset()
    dispatchOnTeamDelegationStart.mockReset()
    dispatchOnTeamDelegationComplete.mockReset()
    teamStartMock.mockReset().mockResolvedValue(undefined)
    teamGetMock.mockReset()
    abortTeamMock.mockReset()
    isInQuietHoursMock.mockReturnValue(false)
  })

  it("rejects self-delegation as a cycle", async () => {
    const { delegation, completionPromise } = delegateToTeam({
      sourceTeamId: "a",
      sourceTaskId: "t",
      targetTeamId: "a",
      reason: "loop",
    })
    expect(delegation.status).toBe("failed")
    expect(delegation.metadata?.error).toMatch(/cycle/)
    expect((await completionPromise).status).toBe("failed")
    expect(teamStartMock).not.toHaveBeenCalled()
  })

  it("detects a multi-hop cycle in the active delegation graph", () => {
    // Active edge b → a already exists; delegating a → b would close the cycle.
    useAgentTeamStore.setState((s) => ({
      delegations: {
        d1: {
          id: "d1",
          sourceTeamId: "b",
          sourceTaskId: "t",
          targetType: "team",
          targetId: "a",
          status: "active",
          reason: "r",
          manual: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as never,
        ...s.delegations,
      },
    }))
    expect(wouldCreateTeamCycle("a", "b")).toBe(true)
    expect(wouldCreateTeamCycle("a", "c")).toBe(false)
  })

  it("runs the target team and settles completed with its finalResult", async () => {
    teamGetMock.mockReturnValue({ id: "b" })
    teamStartMock.mockImplementation(async () => {
      seedTeam("b", { status: "completed", finalResult: "team B output" })
    })
    const { delegation, completionPromise } = delegateToTeam({
      sourceTeamId: "a",
      sourceTaskId: "t",
      targetTeamId: "b",
      reason: "split work",
    })
    expect(delegation.status).toBe("active")
    expect(dispatchOnTeamDelegationStart).toHaveBeenCalledWith(
      expect.objectContaining({ targetType: "team", targetId: "b" })
    )
    const settled = await completionPromise
    expect(teamStartMock).toHaveBeenCalledWith("b", undefined)
    expect(settled.status).toBe("completed")
    expect(settled.result).toBe("team B output")
    expect(dispatchOnTeamDelegationComplete).toHaveBeenCalledWith(
      expect.objectContaining({ status: "completed" })
    )
  })

  it("fails when the target team is not found", async () => {
    teamGetMock.mockReturnValue(undefined)
    const { completionPromise } = delegateToTeam({
      sourceTeamId: "a",
      sourceTaskId: "t",
      targetTeamId: "ghost",
      reason: "x",
    })
    const settled = await completionPromise
    expect(settled.status).toBe("failed")
    expect(teamStartMock).not.toHaveBeenCalled()
  })

  it("fails when the target team run ends non-terminally", async () => {
    teamGetMock.mockReturnValue({ id: "b" })
    teamStartMock.mockImplementation(async () => seedTeam("b", { status: "failed" }))
    const settled = await delegateToTeam({
      sourceTeamId: "a",
      sourceTaskId: "t",
      targetTeamId: "b",
      reason: "x",
    }).completionPromise
    expect(settled.status).toBe("failed")
  })

  it("defers to awaiting_approval inside quiet hours", async () => {
    isInQuietHoursMock.mockReturnValue(true)
    seedTeam("a", {
      config: {
        governancePolicy: { delivery: { quietHours: { from: "22:00", to: "07:00", tz: "UTC" } } },
      },
    })
    const { delegation, completionPromise } = delegateToTeam({
      sourceTeamId: "a",
      sourceTaskId: "t",
      targetTeamId: "b",
      reason: "x",
    })
    expect(delegation.status).toBe("awaiting_approval")
    expect((await completionPromise).status).toBe("awaiting_approval")
    expect(teamStartMock).not.toHaveBeenCalled()
  })

  it("cancelDelegation aborts the target team run", () => {
    teamGetMock.mockReturnValue({ id: "b" })
    teamStartMock.mockReturnValue(new Promise(() => {})) // never settles
    const { delegation } = delegateToTeam({
      sourceTeamId: "a",
      sourceTaskId: "t",
      targetTeamId: "b",
      reason: "x",
    })
    cancelDelegation(delegation.id)
    expect(abortTeamMock).toHaveBeenCalledWith("b", expect.any(String))
    expect(useAgentTeamStore.getState().delegations[delegation.id].status).toBe("cancelled")
  })
})
