import { materializeBackgroundHandoff, materializeExternalHandoff } from "./handoff"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import type { AutoOrchestrationProposal } from "./types"
import type { TeamRoutingAssessment } from "@/types/agent/agent-team"

const assessment: TeamRoutingAssessment = {
  recommendedPattern: "background_handoff",
  confidence: 0.7,
  reason: "Long-running work suits a background run.",
  factors: {
    taskComplexity: "complex",
    specializationNeeded: true,
    contextIsolationNeeded: false,
    delegationCandidate: true,
    budgetPressure: "low",
  },
  createdAt: new Date("2026-07-02T00:00:00Z"),
}

const proposal: AutoOrchestrationProposal = {
  objective: "Migrate the analytics pipeline",
  assessment,
  roster: [
    { name: "Lead", role: "lead", description: "coordinates" },
    { name: "Worker", role: "teammate", description: "does the work" },
  ],
  tasks: [{ title: "Migrate", description: "run it", assignedTo: 1, dependencies: [] }],
  executor: {
    kind: "background-handoff",
    fromPattern: "background_handoff",
    confidence: 0.7,
    reason: "long-running",
  },
}

beforeEach(() => {
  useAgentTeamStore.setState({ teams: {}, teammates: {}, tasks: {}, activeTeamId: null })
})

describe("materializeBackgroundHandoff", () => {
  it("materializes the team and enqueues a one-shot agent-team task in the future", async () => {
    const createTask = jest.fn().mockResolvedValue({ id: "task_bg_1" })
    const before = Date.now()

    const result = await materializeBackgroundHandoff(
      proposal,
      {},
      {
        getScheduler: async () => ({ createTask }),
      }
    )

    expect(useAgentTeamStore.getState().teams[result.teamId]).toBeDefined()
    expect(result.scheduledTaskId).toBe("task_bg_1")
    expect(createTask).toHaveBeenCalledTimes(1)
    const input = createTask.mock.calls[0][0] as {
      type: string
      trigger: { type: string; runAt: Date }
      payload: { teamId: string }
      notification: { onComplete: boolean; onError: boolean }
    }
    expect(input.type).toBe("agent-team")
    expect(input.trigger.type).toBe("once")
    // The once trigger must be strictly in the future.
    expect(input.trigger.runAt.getTime()).toBeGreaterThan(before)
    expect(input.payload).toEqual({ teamId: result.teamId })
    expect(input.notification).toEqual({ onComplete: true, onError: true })
  })

  it("honors a custom runDelayMs", async () => {
    const createTask = jest.fn().mockResolvedValue({ id: "task_bg_2" })
    const before = Date.now()
    await materializeBackgroundHandoff(
      proposal,
      { runDelayMs: 60_000 },
      {
        getScheduler: async () => ({ createTask }),
      }
    )
    const runAt = (createTask.mock.calls[0][0] as { trigger: { runAt: Date } }).trigger.runAt
    expect(runAt.getTime()).toBeGreaterThanOrEqual(before + 60_000)
  })

  it("degrades to team-only when the scheduler throws", async () => {
    const result = await materializeBackgroundHandoff(
      proposal,
      {},
      {
        getScheduler: async () => ({
          createTask: jest.fn().mockRejectedValue(new Error("no scheduler on web")),
        }),
      }
    )
    expect(result.scheduledTaskId).toBeUndefined()
    // The team still exists — honest degraded mode.
    expect(useAgentTeamStore.getState().teams[result.teamId]).toBeDefined()
  })
})

describe("materializeExternalHandoff", () => {
  it("stamps externalPickup.requestedAt and fires one workspace-linked notification", async () => {
    const notify = jest.fn().mockResolvedValue("ntf_1")
    const result = await materializeExternalHandoff(proposal, {}, { notify })

    const team = useAgentTeamStore.getState().teams[result.teamId]
    expect(team.externalPickup?.requestedAt).toBeInstanceOf(Date)
    expect(team.externalPickup?.claimedAt).toBeUndefined()

    expect(notify).toHaveBeenCalledTimes(1)
    const input = notify.mock.calls[0][0] as { href: string; level: string }
    expect(input.level).toBe("info")
    expect(input.href).toBe(`/squads?id=${result.teamId}`)
  })

  it("keeps the pickup stamp even when notification delivery fails", async () => {
    const result = await materializeExternalHandoff(
      proposal,
      {},
      {
        notify: jest.fn().mockRejectedValue(new Error("center offline")),
      }
    )
    const team = useAgentTeamStore.getState().teams[result.teamId]
    expect(team.externalPickup?.requestedAt).toBeInstanceOf(Date)
  })
})
