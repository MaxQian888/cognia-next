import { synthesizeUltracodeWorkflow } from "./synthesize-ultracode"
import type { AgentTeam } from "@/types/agent/agent-team"
import type { UltracodePlan } from "@/types/agent/ultracode"

function team(overrides: Partial<AgentTeam> = {}): AgentTeam {
  return {
    id: "team1",
    name: "Auditors",
    description: "",
    task: "Audit the payments module for bugs",
    status: "executing",
    config: {
      maxTeammates: 5,
      maxConcurrentTeammates: 3,
      executionMode: "coordinated",
      displayMode: "expanded",
      ultracode: { enabled: true, skepticsPerFinding: 3 },
    },
    leadId: "lead",
    teammateIds: [],
    taskIds: [],
    messageIds: [],
    progress: 0,
    totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    createdAt: new Date(0),
    ...overrides,
  } as AgentTeam
}

function nodeById(wf: ReturnType<typeof synthesizeUltracodeWorkflow>["workflow"], id: string) {
  return wf.nodes.find((n) => n.id === id)
}

describe("synthesizeUltracodeWorkflow", () => {
  it("sources settings.retryDefaults from team.config (maxRetries / enableTaskRetry)", () => {
    const plan: UltracodePlan = {
      summary: "audit",
      stages: [{ pattern: "synthesize", instruction: "report" }],
    }
    const retry = synthesizeUltracodeWorkflow({
      team: team({ config: { ...team().config, maxRetries: 4 } }),
      plan,
      initialConcurrency: 2,
    })
    expect(retry.workflow.settings.retryDefaults?.attempts).toBe(5)

    const noRetry = synthesizeUltracodeWorkflow({
      team: team({ config: { ...team().config, maxRetries: 4, enableTaskRetry: false } }),
      plan,
      initialConcurrency: 2,
    })
    expect(noRetry.workflow.settings.retryDefaults?.attempts).toBe(1)
  })

  it("builds a sweep → verify → critic → synthesize DAG with fan-in to synthesize", () => {
    const plan: UltracodePlan = {
      summary: "audit",
      stages: [
        {
          pattern: "multi-modal-sweep",
          instruction: "find bugs",
          variants: ["by-file", "by-call"],
        },
        { pattern: "adversarial-verify", instruction: "refute", count: 3 },
        { pattern: "completeness-critic", instruction: "gaps" },
        { pattern: "synthesize", instruction: "report" },
      ],
    }
    const { workflow, terminalNodeId } = synthesizeUltracodeWorkflow({
      team: team(),
      plan,
      initialConcurrency: 4,
    })

    expect(workflow.id).toMatch(/^__team__:team1:/)
    expect(workflow.nodes).toHaveLength(4)
    expect(workflow.nodes.map((n) => n.type)).toEqual([
      "pattern.multi-modal-sweep",
      "pattern.adversarial-verify",
      "pattern.completeness-critic",
      "pattern.synthesize",
    ])

    const [sweep, verify, critic, synth] = workflow.nodes
    // verify depends on sweep
    expect(workflow.edges).toContainEqual(
      expect.objectContaining({ source: sweep.id, target: verify.id })
    )
    // critic depends on the survivors (verify), not the raw sweep
    expect(workflow.edges).toContainEqual(
      expect.objectContaining({ source: verify.id, target: critic.id })
    )
    expect(workflow.edges).not.toContainEqual(
      expect.objectContaining({ source: sweep.id, target: critic.id })
    )
    // synthesize fans in from every prior node
    for (const prior of [sweep, verify, critic]) {
      expect(workflow.edges).toContainEqual(
        expect.objectContaining({ source: prior.id, target: synth.id })
      )
    }
    expect(terminalNodeId).toBe(synth.id)
  })

  it("maps stage knobs into node params", () => {
    const plan: UltracodePlan = {
      summary: "x",
      stages: [
        { pattern: "loop-until-dry", instruction: "hunt", count: 2 },
        { pattern: "adversarial-verify", instruction: "refute", variants: ["security", "repro"] },
        { pattern: "synthesize", instruction: "report" },
      ],
    }
    const { workflow } = synthesizeUltracodeWorkflow({ team: team(), plan, initialConcurrency: 2 })
    const loop = workflow.nodes[0].data.params as Record<string, unknown>
    expect(loop.finderPrompt).toBe("hunt")
    expect(loop.findersPerRound).toBe(2)
    expect(loop.objective).toBe("Audit the payments module for bugs")

    const verify = workflow.nodes[1].data.params as Record<string, unknown>
    expect(verify.lenses).toEqual(["security", "repro"])
    // count omitted → falls back to team config skepticsPerFinding
    expect(verify.skepticsPerFinding).toBe(3)
  })

  it("appends a synthesize stage when the plan omits one", () => {
    const plan: UltracodePlan = {
      summary: "design",
      stages: [{ pattern: "judge-panel", instruction: "design", variants: ["mvp", "risk"] }],
    }
    const { workflow, terminalNodeId } = synthesizeUltracodeWorkflow({
      team: team(),
      plan,
      initialConcurrency: 2,
    })
    expect(workflow.nodes).toHaveLength(2)
    expect(workflow.nodes[1].type).toBe("pattern.synthesize")
    expect(nodeById(workflow, terminalNodeId)?.type).toBe("pattern.synthesize")
    // judge-panel is independent (no finding deps) but synthesize fans in from it
    expect(workflow.edges).toContainEqual(
      expect.objectContaining({ source: workflow.nodes[0].id, target: workflow.nodes[1].id })
    )
  })

  it("falls back to the instruction when sweep/judge have no variants", () => {
    const plan: UltracodePlan = {
      summary: "x",
      stages: [
        { pattern: "multi-modal-sweep", instruction: "scan everything" },
        { pattern: "judge-panel", instruction: "design it" },
        { pattern: "synthesize", instruction: "r" },
      ],
    }
    const { workflow } = synthesizeUltracodeWorkflow({ team: team(), plan, initialConcurrency: 2 })
    expect((workflow.nodes[0].data.params as { modalities: string[] }).modalities).toEqual([
      "scan everything",
    ])
    const judge = workflow.nodes[1].data.params as { angles: string[]; judgesPerAttempt: number }
    expect(judge.angles).toEqual(["design it"])
    // judgesPerAttempt omitted on stage + team config → default 3
    expect(judge.judgesPerAttempt).toBe(3)
  })

  it("falls back to the objective from description/name when task is blank", () => {
    const t = team({ task: "", description: "Desc objective" })
    const plan: UltracodePlan = {
      summary: "x",
      stages: [{ pattern: "synthesize", instruction: "r" }],
    }
    const { workflow } = synthesizeUltracodeWorkflow({ team: t, plan, initialConcurrency: 1 })
    expect((workflow.nodes[0].data.params as { objective: string }).objective).toBe(
      "Desc objective"
    )
  })

  it("unions multiple finder nodes into a single verify", () => {
    const plan: UltracodePlan = {
      summary: "x",
      stages: [
        { pattern: "multi-modal-sweep", instruction: "a", variants: ["x"] },
        { pattern: "loop-until-dry", instruction: "b" },
        { pattern: "adversarial-verify", instruction: "refute" },
        { pattern: "synthesize", instruction: "r" },
      ],
    }
    const { workflow } = synthesizeUltracodeWorkflow({ team: team(), plan, initialConcurrency: 2 })
    const verifyId = workflow.nodes[2].id
    const verifyDeps = workflow.edges.filter((e) => e.target === verifyId).map((e) => e.source)
    expect(verifyDeps).toEqual([workflow.nodes[0].id, workflow.nodes[1].id])
  })
})
