import type { AgentTeam, AgentTeammate } from "@/types/agent/agent-team"
import { createPlanTeammateRunContext } from "./plan-teammate-context"

function teammate(over: Partial<AgentTeammate> = {}): AgentTeammate {
  return {
    id: over.id ?? "tm1",
    name: over.name ?? "Worker",
    role: over.role ?? "teammate",
    config: over.config ?? {},
  } as AgentTeammate
}

function team(over: Partial<AgentTeam> = {}): AgentTeam {
  return {
    id: over.id ?? "team1",
    name: over.name ?? "Team One",
    teammateIds: over.teammateIds ?? ["tm1"],
    config: over.config ?? { maxConcurrentTeammates: 3, tokenBudget: 0 },
  } as AgentTeam
}

describe("createPlanTeammateRunContext", () => {
  it("builds a TeamRunContext whose pool claims a seeded teammate", () => {
    const tm = teammate({ id: "tm1" })
    const ctx = createPlanTeammateRunContext({ runId: "r1", team: team(), teammates: [tm] })

    expect(ctx.runId).toBe("r1")
    expect(ctx.teamId).toBe("team1")
    const claimed = ctx.pool.claim("step-1")
    expect(claimed?.id).toBe("tm1")
  })

  it("wires budget / concurrency / modelPref / notifier with correct shapes", () => {
    const ctx = createPlanTeammateRunContext({
      runId: "r1",
      team: team({
        config: { maxConcurrentTeammates: 7, tokenBudget: 1000 } as AgentTeam["config"],
      }),
      teammates: [teammate()],
    })

    expect(ctx.budget.status()).toMatchObject({ used: 0, limit: 1000 })
    expect(ctx.concurrency.get()).toBe(7)
    expect(ctx.modelPref.get()).toMatchObject({ preferCheap: false })
    expect(typeof ctx.notifier.notify).toBe("function")
  })

  it("defaults concurrency to 5 and budget to unlimited when config omits them", () => {
    const ctx = createPlanTeammateRunContext({
      runId: "r1",
      team: team({ config: {} as AgentTeam["config"] }),
      teammates: [teammate()],
    })
    expect(ctx.concurrency.get()).toBe(5)
    expect(ctx.budget.status().limit).toBe(0)
  })

  it("exposes callable no-op storeWriter methods and empty caches", () => {
    const ctx = createPlanTeammateRunContext({ runId: "r1", team: team(), teammates: [teammate()] })

    expect(() => {
      ctx.storeWriter.addMessage({
        teamId: "team1",
        senderId: "tm1",
        type: "result_share",
        content: "x",
      })
      ctx.storeWriter.setTaskStatus("t", "completed", "ok")
      ctx.storeWriter.updateTeammate("tm1", {})
    }).not.toThrow()
    expect(ctx.resolvedCapabilities.size).toBe(0)
    expect(ctx.externalAgentInstances.size).toBe(0)
  })
})
