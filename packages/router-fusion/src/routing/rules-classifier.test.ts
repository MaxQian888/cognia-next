import type { ClassifierLabels } from "./features"
import { classifyWithRules, difficultyTierOf } from "./rules-classifier"

function labels(overrides: Partial<ClassifierLabels> = {}): ClassifierLabels {
  return {
    task: "text.transform",
    ambiguity: "low",
    tool_need: "none",
    scope: "single_item",
    missing_information: [],
    goal: "",
    ...overrides,
  }
}

describe("difficultyTierOf (the absorbed difficulty judge, D18)", () => {
  it("names the fast tier only for a clear, tool-free transform, extraction or lookup", () => {
    for (const task of ["text.transform", "data.extract", "qa.knowledge"] as const) {
      expect(difficultyTierOf(labels({ task }))).toBe("fast")
      expect(difficultyTierOf(labels({ task, ambiguity: "medium" }))).toBe("balanced")
      expect(difficultyTierOf(labels({ task, tool_need: "read_only" }))).toBe("balanced")
      expect(difficultyTierOf(labels({ task, scope: "multi_file" }))).toBe("balanced")
    }
  })

  it("names the powerful tier for reasoning, research, planning and agentic work", () => {
    for (const task of [
      "reasoning.solve",
      "research.synthesis",
      "agent.plan",
      "agent.execute",
    ] as const) {
      expect(difficultyTierOf(labels({ task }))).toBe("powerful")
    }
  })

  it("grades code work by its reach and clarity", () => {
    expect(difficultyTierOf(labels({ task: "code.implement", scope: "single_file" }))).toBe(
      "balanced"
    )
    expect(difficultyTierOf(labels({ task: "code.debug", scope: "cross_system" }))).toBe("powerful")
    expect(difficultyTierOf(labels({ task: "code.implement", ambiguity: "high" }))).toBe("powerful")
    expect(difficultyTierOf(labels({ task: "code.review", scope: "single_file" }))).toBe("balanced")
    expect(difficultyTierOf(labels({ task: "code.review", scope: "multi_file" }))).toBe("powerful")
  })

  it("has no answer when the labels do not know the task or how clear it is", () => {
    expect(difficultyTierOf(labels({ task: "unknown" }))).toBeNull()
    expect(difficultyTierOf(labels({ ambiguity: "unknown" }))).toBeNull()
    expect(difficultyTierOf(classifyWithRules("asdf qwer"))).toBeNull()
  })

  it("reads the rules classifier's own labels the same way", () => {
    expect(difficultyTierOf(classifyWithRules("Please translate this into German"))).toBe("fast")
    expect(
      difficultyTierOf(classifyWithRules("Prove that the sum of two even numbers is even"))
    ).toBe("powerful")
  })
})
