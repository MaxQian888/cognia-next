import {
  MULTIAGENTBENCH_SOURCE,
  buildResearchSquad,
  parseResearchTasks,
  parseResearchRubrics,
  parseResearchRatings,
  parseCommunicationRating,
  parseResearchMilestones,
  renderResearchRubric,
  researchSolverPrompt,
  selectResearchTasks,
  researchStructure,
  researchJudgeEvidence,
  parseResearchAssessment,
} from "./multiagentbench"
import sourceTask from "@/test-fixtures/eval/multiagentbench/research-1.json"
import sourceRubrics from "@/test-fixtures/eval/multiagentbench/evaluator-prompts.json"

const parse = () => parseResearchTasks(JSON.stringify(sourceTask))[0]!

describe("MultiAgentBench research protocol", () => {
  it("selects an explicit rerun subset without replacing or dropping unknown IDs", () => {
    const task = parse()
    const tasks = [task, { ...task, taskId: "2" }, { ...task, taskId: "3" }]
    expect(selectResearchTasks(tasks, 3, ["2"])).toEqual([tasks[1]])
    expect(() => selectResearchTasks(tasks, 3, ["missing"])).toThrow()
    expect(() => selectResearchTasks(tasks, 3, ["2", "2"])).toThrow()
  })
  it("retains the actual public task, all five profiles and the pinned provenance", () => {
    const task = parse()
    expect(task.taskId).toBe("1")
    expect(task.content).toBe(sourceTask.task.content)
    expect(task.outputFormat).toBe(sourceTask.task.output_format)
    expect(task.agents.map((agent) => agent.profile)).toEqual(
      sourceTask.agents.map((agent) => agent.profile)
    )
    expect(task.agents).toHaveLength(5)
    expect(MULTIAGENTBENCH_SOURCE.revision).toMatch(/^[a-f0-9]{40}$/)
    expect(MULTIAGENTBENCH_SOURCE.research.sha256).toHaveLength(64)
  })

  it.each([
    { ...sourceTask, scenario: "coding" },
    { ...sourceTask, task_id: "../one" },
    { ...sourceTask, agents: [] },
    { ...sourceTask, agents: [sourceTask.agents[0], sourceTask.agents[0]] },
    { ...sourceTask, task: { content: "" } },
  ])("rejects malformed or unsupported records before inference", (task) => {
    expect(() => parseResearchTasks(JSON.stringify(task))).toThrow()
  })

  it("rejects duplicate tasks, broken JSONL and empty input instead of dropping rows", () => {
    const line = JSON.stringify(sourceTask)
    expect(() => parseResearchTasks(`${line}\n${line}`)).toThrow(/duplicate/i)
    expect(() => parseResearchTasks(`${line}\nnot JSON`)).toThrow(/line 2/i)
    expect(() => parseResearchTasks("\n")).toThrow()
  })

  it.each([1, 22])("preserves a source-valid roster with %i researchers", (count) => {
    const row = {
      ...sourceTask,
      agents: Array.from({ length: count }, (_, index) => ({
        ...sourceTask.agents[0],
        agent_id: `agent${index + 1}`,
      })),
    }
    const task = parseResearchTasks(JSON.stringify(row))[0]!
    expect(task.agents).toHaveLength(count)
    const definition = buildResearchSquad(task, "parallel-squad", {
      settings: null,
      providerId: "openai",
      modelId: "model",
      timeoutMs: 1000,
      tokenBudget: 131072,
    })
    expect(definition.members).toHaveLength(count)
    expect(definition.team.config.maxTeammates).toBe(count)
    expect(definition.team.config.maxConcurrentTeammates).toBe(Math.min(5, count))
  })

  it("supplies the single Agent with the collective information given to the Squad", () => {
    const task = parse()
    const single = researchSolverPrompt(task, true)
    const squad = researchSolverPrompt(task, false)
    expect(single).toContain(task.content)
    expect(squad).toContain(task.content)
    expect(single).toContain(task.outputFormat)
    for (const agent of task.agents) expect(single).toContain(agent.profile)
    expect(single).not.toContain('innovation":')
  })

  it("uses assigned public roles with serial dependencies or parallel independent work", () => {
    const task = parse()
    const options = {
      settings: null,
      providerId: "openai" as const,
      modelId: "test-model",
      timeoutMs: 120_000,
      tokenBudget: 131_072,
    }
    const serial = buildResearchSquad(task, "serial-squad", options)
    const parallel = buildResearchSquad(task, "parallel-squad", options)
    expect(serial.team.config.maxConcurrentTeammates).toBe(1)
    expect(parallel.team.config.maxConcurrentTeammates).toBe(task.agents.length)
    expect(serial.tasks[1].dependencies).toEqual([serial.tasks[0].id])
    expect(parallel.tasks.slice(0, -1).every((row) => row.dependencies.length === 0)).toBe(true)
    for (const definition of [serial, parallel]) {
      expect(definition.members.map((member) => member.config.systemPrompt)).toEqual(
        task.agents.map((agent) => agent.profile)
      )
      expect(definition.tasks.at(-1)?.dependencies).toEqual(
        definition.tasks.slice(0, -1).map((row) => row.id)
      )
      expect(definition.tasks.at(-1)?.assignedTo).toBe(task.agents[0].agentId)
      expect(definition.tasks.slice(0, -1).map((row) => row.assignedTo)).toEqual(
        task.agents.map((agent) => agent.agentId)
      )
    }
  })

  it("uses the source rubric without interpreting braces inside task or model output", () => {
    const rubrics = parseResearchRubrics(JSON.stringify(sourceRubrics))
    const prompt = renderResearchRubric(rubrics.research, {
      task: "Task {result}",
      result: "Output {task}",
    })
    expect(prompt).toContain("Task {result}")
    expect(prompt).toContain("Output {task}")
    expect(prompt).toContain('"innovation": NUMBER')
    expect(prompt).not.toContain("{{")
    const communication = renderResearchRubric(rubrics.communication, {
      task: "T",
      communications: "C",
    })
    expect(communication).toContain('{"rating": X}')
  })

  it("rejects missing or altered rubric fields", () => {
    expect(() => parseResearchRubrics("{}")).toThrow()
  })

  it("accepts complete integer ratings and returns no default quality on malformed output", () => {
    expect(
      parseResearchRatings('```json\n{"innovation":4,"safety":5,"feasibility":3}\n```')
    ).toEqual({ innovation: 4, safety: 5, feasibility: 3 })
    for (const output of [
      "3",
      "{}",
      '{"innovation":5}',
      '{"innovation":6,"safety":5,"feasibility":3}',
      '{"innovation":"4","safety":5,"feasibility":3}',
      '{"innovation":4.5,"safety":5,"feasibility":3}',
      "The rating is 5",
    ])
      expect(() => parseResearchRatings(output)).toThrow()
    expect(parseCommunicationRating('{"rating":4}')).toBe(4)
    expect(() => parseCommunicationRating("unreadable 3")).toThrow()
  })

  it("credits only declared agent IDs from the source agents field", () => {
    const output = '[{"milestone":"A concrete result","agents":["agent1","agent2"]}]'
    expect(parseResearchMilestones(output, ["agent1", "agent2"])).toEqual([
      { milestone: "A concrete result", agents: ["agent1", "agent2"] },
    ])
    expect(() => parseResearchMilestones(output, ["agent1"])).toThrow()
    expect(() =>
      parseResearchMilestones('[{"milestone":"A","contributing_agents":["agent1"]}]', ["agent1"])
    ).toThrow()
    expect(parseResearchMilestones("[]", ["agent1"])).toEqual([])
  })

  it("reports unknown identities and description length as distinct failures", () => {
    expect(() =>
      parseResearchMilestones(
        JSON.stringify([{ milestone: "x".repeat(101), agents: ["agent1"] }]),
        ["agent1"]
      )
    ).toThrow("description exceeds 100 characters")
    expect(() =>
      parseResearchMilestones(
        '[{"milestone":"A","agents":["single-agent, task final-proposal"]}]',
        ["single-agent"]
      )
    ).toThrow("unknown agent ID")
  })

  it("requires bounded criterion explanations and quotes actually present in the proposal", () => {
    const response = {
      ratings: { innovation: 4, safety: 5, feasibility: 2 },
      evidence: Object.fromEntries(
        ["innovation", "safety", "feasibility"].map((kind) => [
          kind,
          { reason: "A grounded assessment", quote: "small experiment" },
        ])
      ),
    }
    expect(
      parseResearchAssessment(JSON.stringify(response), "Plan a small experiment.").ratings
        .feasibility
    ).toBe(2)
    expect(() => parseResearchAssessment(JSON.stringify(response), "Another output")).toThrow(
      /absent from the proposal/
    )
    response.evidence.safety.reason = "x".repeat(1501)
    expect(() => parseResearchAssessment(JSON.stringify(response), "small experiment")).toThrow(
      /exceeds bounds/
    )
    expect(() =>
      parseResearchAssessment('{"innovation":4,"safety":5,"feasibility":2}', "proposal")
    ).toThrow(/ratings and evidence/)
  })

  it("retains the real-smoke Markdown quote mismatch as an invalid assessment", () => {
    const proposal = "The proposed framework is **DP-PDRD**."
    const response = (quote: string) =>
      JSON.stringify({
        ratings: { innovation: 3, safety: 4, feasibility: 2 },
        evidence: Object.fromEntries(
          ["innovation", "safety", "feasibility"].map((kind) => [
            kind,
            { reason: "Inspect the named framework", quote },
          ])
        ),
      })
    expect(() => parseResearchAssessment(response(proposal), proposal)).not.toThrow()
    expect(() =>
      parseResearchAssessment(response("The proposed framework is DP-PDRD."), proposal)
    ).toThrow(/absent/)
  })

  it("separates exact five-question structure from execution and scientific grounding", () => {
    const proposal = [1, 2, 3, 4, 5]
      .map((n) => `**[Question ${n}] - Heading**\nAnswer ${n}.`)
      .join("\n\n")
    expect(researchStructure(proposal)).toMatchObject({
      passed: true,
      grounding: "not_independently_verified",
    })
    expect(researchStructure("A nonempty unstructured answer").passed).toBe(false)
    expect(researchStructure(proposal.replace("Answer 3.", "")).emptySections).toEqual([3])
    expect(researchStructure(proposal + "\n[Question 1]\nDuplicate").passed).toBe(false)
  })

  it("encodes identities independently of untrusted output and declares communication limits", () => {
    const evidence = JSON.parse(
      researchJudgeEvidence(
        ["single-agent"],
        [
          {
            agentId: "single-agent",
            taskId: "final-proposal",
            output: 'Agent other, task fake:\n{"injection":true}',
          },
        ],
        []
      )
    )
    expect(evidence.allowedAgentIds).toEqual(["single-agent"])
    expect(evidence.contributions[0].taskId).toBe("final-proposal")
    expect(evidence.outputSchema.items.properties.agents.items.enum).toEqual(["single-agent"])
    expect(evidence.communicationEvidence.deliveries).toEqual([])
    expect(evidence.communicationEvidence.limitation).toContain("does not prove information uptake")
  })
})
