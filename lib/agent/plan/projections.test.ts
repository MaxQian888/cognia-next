import type { AgentTeam, AgentTeamTask } from "@/types/agent/agent-team"
import type { Goal, GoalSubgoal } from "@/types/goal"
import {
  planInputFromGoal,
  planInputFromTeam,
  planStepsFromTeamTasks,
  teamTaskInputsFromPlan,
} from "./projections"

function task(over: Partial<AgentTeamTask>): AgentTeamTask {
  return {
    id: over.id ?? "t1",
    teamId: "team1",
    title: over.title ?? "Task",
    description: over.description ?? "",
    status: "pending",
    priority: "normal",
    dependencies: over.dependencies ?? [],
    tags: [],
    order: over.order ?? 0,
    createdAt: new Date(0),
    assignedTo: over.assignedTo,
    estimatedDuration: over.estimatedDuration,
  } as AgentTeamTask
}

describe("planStepsFromTeamTasks", () => {
  it("maps tasks to teammate_dispatch steps and remaps dep ids to indices", () => {
    const steps = planStepsFromTeamTasks([
      task({ id: "a", title: "A" }),
      task({ id: "b", title: "B", dependencies: ["a"], assignedTo: "mate1" }),
    ])
    expect(steps[0].kind).toBe("teammate_dispatch")
    expect(steps[1].dependsOn).toEqual([0])
    expect(steps[1].params).toEqual({ kind: "teammate_dispatch", teammateId: "mate1" })
  })

  it("drops 'any' assignment and unknown dep ids", () => {
    const steps = planStepsFromTeamTasks([
      task({ id: "a", assignedTo: "any", dependencies: ["ghost"] }),
    ])
    expect(steps[0].params).toEqual({ kind: "teammate_dispatch" })
    expect(steps[0].dependsOn).toBeUndefined()
  })

  it("carries estimatedDuration through", () => {
    const steps = planStepsFromTeamTasks([task({ id: "a", estimatedDuration: 5000 })])
    expect(steps[0].estimatedDurationMs).toBe(5000)
  })
})

describe("planInputFromTeam", () => {
  it("produces an orchestrated team_projection plan", () => {
    const team = { id: "tm", name: "Squad", description: "do work" } as AgentTeam
    const input = planInputFromTeam(team, [task({ id: "a" })], { sessionId: "ses" })
    expect(input).toMatchObject({
      sessionId: "ses",
      title: "Squad",
      source: "team_projection",
      executionMode: "orchestrated",
      metadata: { teamId: "tm" },
    })
    expect(input.steps).toHaveLength(1)
  })
})

function goal(over: Partial<Goal>): Goal {
  return {
    id: over.id ?? "g1",
    sessionId: over.sessionId ?? "ses_g",
    characterId: over.characterId,
    rawObjective: "raw",
    safeObjective: over.safeObjective ?? "Ship the thing",
    redactionMapEnc: "",
    status: "active",
    turnsUsed: 0,
    tokensUsed: 0,
    judgeFailureCount: 0,
    config: {} as Goal["config"],
    generationId: "g",
    createdAt: 0,
    updatedAt: 0,
    subgoals: over.subgoals,
  }
}

function subgoal(text: string, order: number): GoalSubgoal {
  return { id: `sg${order}`, text, done: false, order }
}

describe("planInputFromGoal", () => {
  it("maps ordered subgoals to a linear agent_turn plan", () => {
    const input = planInputFromGoal(
      goal({ subgoals: [subgoal("second", 1), subgoal("first", 0)], characterId: "c1" })
    )
    expect(input.source).toBe("goal_projection")
    expect(input.executionMode).toBe("in_session")
    expect(input.characterId).toBe("c1")
    expect(input.steps.map((s) => s.title)).toEqual(["first", "second"])
    expect(input.steps[1].dependsOn).toEqual([0])
    expect(input.metadata).toEqual({ goalId: "g1" })
  })

  it("falls back to a single step from the objective when there are no subgoals", () => {
    const input = planInputFromGoal(goal({ safeObjective: "Just do it" }))
    expect(input.steps).toHaveLength(1)
    expect(input.steps[0].title).toBe("Just do it")
    expect(input.steps[0].kind).toBe("agent_turn")
  })

  it("honors an explicit sessionId override", () => {
    expect(
      planInputFromGoal(goal({ sessionId: "orig" }), { sessionId: "override" }).sessionId
    ).toBe("override")
  })
})

describe("teamTaskInputsFromPlan (round-trip)", () => {
  it("preserves the dependency DAG via stable step ids", () => {
    // team tasks → plan steps → team task inputs should keep the a→b edge.
    const steps = planStepsFromTeamTasks([
      task({ id: "a", title: "A" }),
      task({ id: "b", title: "B", dependencies: ["a"] }),
    ])
    // Materialise minimal PlanSteps with ids (simulating runtime materialisation).
    const plan = {
      steps: [
        { id: "s_a", title: steps[0].title, dependencies: [] },
        { id: "s_b", title: steps[1].title, dependencies: ["s_a"] },
      ],
    } as Parameters<typeof teamTaskInputsFromPlan>[0]
    const back = teamTaskInputsFromPlan(plan)
    expect(back).toEqual([
      { id: "s_a", title: "A", description: "", dependencies: [] },
      { id: "s_b", title: "B", description: "", dependencies: ["s_a"] },
    ])
  })
})
