import { assessRouting, heuristicAssessment } from "./assess-routing"
import { EMPTY_CAPABILITY_CATALOG } from "./capability-catalog"
import type { LlmClient } from "@/lib/twin/distill/llm"

const NOW = new Date("2026-06-14T00:00:00Z")
const now = () => NOW
const client = (text: string): LlmClient => ({ complete: async () => text })
const throwingClient = (): LlmClient => ({
  complete: async () => {
    throw new Error("network")
  },
})

const base = {
  catalog: EMPTY_CAPABILITY_CATALOG,
  now,
}

describe("assessRouting (model path)", () => {
  it("parses and clamps a valid model response", async () => {
    const result = await assessRouting({
      ...base,
      objective: "do the thing",
      client: client(
        '{"recommendedPattern":"parallel_specialists","confidence":1.7,"reason":"Independent angles.","factors":{"taskComplexity":"complex","specializationNeeded":true,"contextIsolationNeeded":true,"delegationCandidate":false,"budgetPressure":"high"}}'
      ),
    })
    expect(result.recommendedPattern).toBe("parallel_specialists")
    expect(result.confidence).toBe(1) // clamped
    expect(result.factors.taskComplexity).toBe("complex")
    expect(result.factors.budgetPressure).toBe("high")
    expect(result.createdAt).toBe(NOW)
  })

  it("falls back to safe defaults for unknown enum values", async () => {
    const result = await assessRouting({
      ...base,
      objective: "x",
      client: client(
        '{"recommendedPattern":"bogus","confidence":"nope","factors":{"taskComplexity":"weird","budgetPressure":"extreme"}}'
      ),
    })
    expect(result.recommendedPattern).toBe("manager_worker")
    expect(result.confidence).toBe(0.6)
    expect(result.factors.taskComplexity).toBe("moderate")
    expect(result.factors.budgetPressure).toBe("low")
    expect(result.factors.specializationNeeded).toBe(false)
  })
})

describe("assessRouting (prompt rendering)", () => {
  it("embeds available capability counts in the prompt", async () => {
    let seenPrompt = ""
    await assessRouting({
      now,
      objective: "x",
      catalog: {
        skillIds: ["a", "b"],
        mcpServerIds: [],
        nativeAnthropicToolIds: [],
        characterPackIds: [],
        externalAgentPresetIds: ["claude-code", "codex"],
        subagentIds: ["workflow-designer"],
      },
      client: {
        complete: async (prompt) => {
          seenPrompt = prompt
          return '{"recommendedPattern":"manager_worker"}'
        },
      },
    })
    expect(seenPrompt).toContain("skills: 2")
    expect(seenPrompt).toContain("subagents: 1")
    expect(seenPrompt).toContain("external agents: claude-code, codex")
  })

  it("falls back to a default reason when the model omits one", async () => {
    const result = await assessRouting({
      ...base,
      objective: "x",
      client: client('{"recommendedPattern":"manager_worker","reason":"   "}'),
    })
    expect(result.reason).toBe("Routing assessed by model.")
  })
})

describe("assessRouting (fail-open)", () => {
  it("uses the heuristic when the model throws", async () => {
    const result = await assessRouting({
      ...base,
      objective: "refactor the entire authentication architecture across services",
      client: throwingClient(),
    })
    expect(result.factors.taskComplexity).toBe("complex")
    expect(result.recommendedPattern).toBe("ultracode_orchestration")
    expect(result.reason).toMatch(/Heuristic/)
  })

  it("uses the heuristic when the model returns non-JSON", async () => {
    const result = await assessRouting({ ...base, objective: "ship it", client: client("sure!") })
    expect(result.confidence).toBe(0.4)
  })

  it("short-circuits to the heuristic when already aborted", async () => {
    const ac = new AbortController()
    ac.abort()
    const spy = jest.fn()
    const result = await assessRouting({
      ...base,
      objective: "anything",
      client: { complete: spy },
      signal: ac.signal,
    })
    expect(spy).not.toHaveBeenCalled()
    expect(result.reason).toMatch(/Heuristic/)
  })

  it("falls back to the heuristic when aborted mid-call", async () => {
    const ac = new AbortController()
    const result = await assessRouting({
      ...base,
      objective: "anything",
      client: {
        complete: async () => {
          ac.abort()
          return '{"recommendedPattern":"parallel_specialists"}'
        },
      },
      signal: ac.signal,
    })
    expect(result.reason).toMatch(/Heuristic/)
  })
})

describe("heuristicAssessment", () => {
  it("rates a short objective simple → single agent", () => {
    const a = heuristicAssessment("fix typo", NOW)
    expect(a.factors.taskComplexity).toBe("simple")
    expect(a.recommendedPattern).toBe("single_agent_recommended")
  })

  it("rates a parallel-flavored moderate objective parallel_specialists", () => {
    const a = heuristicAssessment("review each module for style and naming consistency", NOW)
    expect(a.factors.taskComplexity).toBe("moderate")
    expect(a.recommendedPattern).toBe("parallel_specialists")
    expect(a.factors.specializationNeeded).toBe(true)
  })

  it("flags delegation candidates and complex budget pressure", () => {
    const a = heuristicAssessment("migrate the whole codebase overnight in the background", NOW)
    expect(a.factors.taskComplexity).toBe("complex")
    expect(a.factors.delegationCandidate).toBe(true)
    expect(a.factors.budgetPressure).toBe("medium")
  })

  it("defaults a plain moderate objective to manager_worker", () => {
    const a = heuristicAssessment(
      "write detailed user documentation for the settings and preferences page",
      NOW
    )
    expect(a.factors.taskComplexity).toBe("moderate")
    expect(a.recommendedPattern).toBe("manager_worker")
  })
})
