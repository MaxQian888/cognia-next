import type { AiBridge } from "../lib/ai"
import { evaluateAnswer, normalizeEvaluation } from "./evaluate"

function aiReturning(text: string | (() => never)): AiBridge {
  return {
    chat: async function* () {
      if (typeof text === "function") text()
      yield { content: text as string, usage: { totalTokens: 12 } }
    },
    embed: async (t) => t.map(() => [0]),
  }
}

describe("normalizeEvaluation", () => {
  it("requires pass === true", () => {
    expect(normalizeEvaluation({ pass: true, reasons: ["ok"] })).toEqual({
      pass: true,
      reasons: ["ok"],
    })
    expect(normalizeEvaluation({ pass: "yes" }).pass).toBe(false)
  })
  it("defaults reasons to an empty array", () => {
    expect(normalizeEvaluation({ pass: false }).reasons).toEqual([])
  })
})

describe("evaluateAnswer", () => {
  it("returns the parsed verdict and tokens", async () => {
    const { evaluation, tokens } = await evaluateAnswer(
      "q",
      "answer [1]",
      "[1] src",
      aiReturning('{"pass":true,"reasons":["grounded"]}')
    )
    expect(evaluation).toEqual({ pass: true, reasons: ["grounded"] })
    expect(tokens).toBe(12)
  })

  it("returns a failing verdict for a rejected answer", async () => {
    const { evaluation } = await evaluateAnswer(
      "q",
      "hallucinated",
      "[1] src",
      aiReturning('{"pass":false,"reasons":["unsupported claim"]}')
    )
    expect(evaluation.pass).toBe(false)
    expect(evaluation.reasons).toContain("unsupported claim")
  })

  it("fails OPEN (pass=true) when the evaluator throws", async () => {
    const throwing: AiBridge = {
      chat: async function* () {
        throw new Error("boom")
      },
      embed: async () => [],
    }
    const { evaluation, tokens } = await evaluateAnswer("q", "a", "e", throwing)
    expect(evaluation.pass).toBe(true)
    expect(tokens).toBe(0)
  })
})
