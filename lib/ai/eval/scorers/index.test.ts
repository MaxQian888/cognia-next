import type { LlmClient } from "@/lib/twin/distill/llm"
import { deterministicScorers, llmScorers } from "./index"

const client: LlmClient = {
  async complete() {
    return "{}"
  },
}

describe("scorer set builders", () => {
  it("deterministicScorers are all non-LLM (CI tier)", () => {
    const set = deterministicScorers()
    expect(set.length).toBeGreaterThan(0)
    expect(set.every((s) => s.requiresLlm === false)).toBe(true)
  })

  it("deterministicScorers include the core tool-use and cost scorers", () => {
    const ids = deterministicScorers().map((s) => s.id)
    expect(ids).toEqual(
      expect.arrayContaining([
        "tool-selection",
        "tool-args",
        "tool-order",
        "tool-redundancy",
        "cost",
      ])
    )
  })

  it("llmScorers all require an LLM and cover response-quality + rag", () => {
    const set = llmScorers({ client })
    expect(set.length).toBeGreaterThan(0)
    expect(set.every((s) => s.requiresLlm === true)).toBe(true)
    const dims = new Set(set.map((s) => s.dimension))
    expect(dims.has("response-quality")).toBe(true)
    expect(dims.has("rag")).toBe(true)
  })

  it("deterministicScorers honor a cost budget gate", () => {
    const ids = deterministicScorers({ costBudget: { maxCostUsd: 0.01 } }).map((s) => s.id)
    expect(ids).toContain("cost")
  })

  it("llmScorers can exclude the RAG scorers", () => {
    const dims = new Set(llmScorers({ client, includeRag: false }).map((s) => s.dimension))
    expect(dims.has("rag")).toBe(false)
    expect(dims.has("response-quality")).toBe(true)
  })
})
