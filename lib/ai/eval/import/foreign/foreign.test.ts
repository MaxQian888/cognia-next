import { importForeign, fromPromptfoo, fromOpenAiEvals, fromLangSmith } from "./index"

let counter = 0
const deps = { datasetId: "d", capability: "chat", now: () => 1, id: () => `evc_${counter++}` }
beforeEach(() => {
  counter = 0
})

describe("fromPromptfoo", () => {
  it("maps vars + equals/contains asserts", () => {
    const out = fromPromptfoo(
      {
        tests: [
          {
            vars: { input: "Translate hi", language: "fr" },
            assert: [
              { type: "equals", value: "salut" },
              { type: "contains", value: "bonjour" },
            ],
            description: "greeting",
          },
        ],
      },
      deps
    )
    expect(out.cases[0].input).toBe("Translate hi")
    expect(out.cases[0].inputVars).toEqual({ input: "Translate hi", language: "fr" })
    expect(out.cases[0].reference?.expectedOutput).toBe("salut")
    expect(out.cases[0].reference?.expectedContains).toEqual(["bonjour"])
    expect(out.cases[0].metadata).toEqual({ description: "greeting" })
  })

  it("skips tests with no input/vars", () => {
    const out = fromPromptfoo([{ assert: [] }], deps)
    expect(out.cases).toHaveLength(0)
    expect(out.skipped[0].reason).toMatch(/no input/)
  })
})

describe("fromOpenAiEvals", () => {
  it("maps string input + string ideal", () => {
    const out = fromOpenAiEvals([{ input: "2+2?", ideal: "4" }], deps)
    expect(out.cases[0].input).toBe("2+2?")
    expect(out.cases[0].reference?.expectedOutput).toBe("4")
  })

  it("maps chat-message input (last user) + array ideal", () => {
    const out = fromOpenAiEvals(
      [
        {
          input: [
            { role: "system", content: "be terse" },
            { role: "user", content: "capital of France?" },
          ],
          ideal: ["Paris", "paris"],
        },
      ],
      deps
    )
    expect(out.cases[0].input).toBe("capital of France?")
    expect(out.cases[0].reference?.expectedContains).toEqual(["Paris", "paris"])
  })

  it("skips samples with no input", () => {
    const out = fromOpenAiEvals([{ ideal: "x" }], deps)
    expect(out.cases).toHaveLength(0)
  })
})

describe("fromLangSmith", () => {
  it("maps inputs/outputs", () => {
    const out = fromLangSmith([{ inputs: { question: "hi" }, outputs: { answer: "yo" } }], deps)
    expect(out.cases[0].input).toBe("hi")
    expect(out.cases[0].inputVars).toEqual({ question: "hi" })
    expect(out.cases[0].reference?.expectedOutput).toBe("yo")
  })

  it("stringifies multi-key inputs", () => {
    const out = fromLangSmith([{ inputs: { a: "1", b: "2" }, outputs: {} }], deps)
    expect(JSON.parse(out.cases[0].input)).toEqual({ a: "1", b: "2" })
    expect(out.cases[0].reference).toBeUndefined()
  })

  it("uses a single non-named input value + a named output key", () => {
    const out = fromLangSmith([{ inputs: { foo: "bar" }, outputs: { response: "r" } }], deps)
    expect(out.cases[0].input).toBe("bar")
    expect(out.cases[0].reference?.expectedOutput).toBe("r")
  })

  it("stringifies multi-key outputs and skips rows with no inputs", () => {
    const out = fromLangSmith(
      [
        { inputs: { question: "q" }, outputs: { a: "1", b: "2" } },
        { inputs: {}, outputs: { answer: "x" } },
        42,
      ],
      deps
    )
    expect(out.cases).toHaveLength(1)
    expect(JSON.parse(out.cases[0].reference!.expectedOutput!)).toEqual({ a: "1", b: "2" })
    expect(out.skipped.map((s) => s.reason)).toEqual(
      expect.arrayContaining(["no inputs", "not an object"])
    )
  })
})

describe("importForeign dispatch", () => {
  it("routes by format", () => {
    expect(importForeign("promptfoo", [{ vars: { input: "x" } }], deps).cases).toHaveLength(1)
    expect(importForeign("openai-evals", [{ input: "x" }], deps).cases).toHaveLength(1)
    expect(importForeign("langsmith", [{ inputs: { input: "x" } }], deps).cases).toHaveLength(1)
  })

  it("skips non-object items", () => {
    expect(fromPromptfoo([42], deps).skipped[0].reason).toMatch(/not an object/)
  })
})
