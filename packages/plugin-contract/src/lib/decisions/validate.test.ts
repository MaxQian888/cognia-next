import {
  MAX_DECISION_REQUEST_CHARS,
  validateDecisionQuestions,
  validateDecisionRequest,
} from "./validate"

const noul = { q: { type: "noul", instructions: "Is it tense?" } }

describe("validateDecisionQuestions", () => {
  it("accepts the three question types", () => {
    expect(
      validateDecisionQuestions({
        tense: { type: "noul", instructions: "?", criteria: { true: "yes", false: "no" } },
        intent: { type: "choice", instructions: "?", criteria: { a: "x", b: "y" } },
        danger: { type: "score", instructions: "?", criteria: ["low", "high"] },
      })
    ).toBeNull()
  })

  it.each([
    [{}, "non-empty"],
    [[], "non-empty"],
    [{ q: "noul" }, "must be an object"],
    [{ q: { type: "maybe", instructions: "?" } }, "unknown type"],
    [{ q: { type: "noul", instructions: "  " } }, "instructions"],
    [{ q: { type: "choice", instructions: "?", criteria: { a: "x" } } }, "2-255"],
    [{ q: { type: "choice", instructions: "?", criteria: ["a", "b"] } }, "criteria object"],
    [{ q: { type: "choice", instructions: "?", criteria: { a: "x", b: 1 } } }, "strings"],
    [{ q: { type: "score", instructions: "?", criteria: ["only"] } }, "2 criteria"],
    [{ q: { type: "score", instructions: "?", criteria: ["a", 2] } }, "strings"],
    [{ q: { type: "noul", instructions: "?", criteria: { maybe: "x" } } }, "true"],
    [{ q: { type: "noul", instructions: "?", criteria: { true: 1 } } }, "strings"],
  ])("rejects %j", (questions, fragment) => {
    expect(validateDecisionQuestions(questions)).toContain(fragment)
  })

  it("caps choice options at 255", () => {
    const criteria = Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`o${i}`, "x"]))
    expect(
      validateDecisionQuestions({ q: { type: "choice", instructions: "?", criteria } })
    ).toContain("2-255")
  })
})

describe("validateDecisionRequest", () => {
  it("narrows a valid request and keeps stateTrim", () => {
    const result = validateDecisionRequest({
      state: { chat: { messages: [{ from: "other", text: "hi" }] } },
      questions: noul,
      stateTrim: ["chat", "messages"],
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.request.stateTrim).toEqual(["chat", "messages"])
  })

  it.each([
    [null, "request must be an object"],
    [{ state: "", questions: noul }, "state must be non-empty"],
    [{ state: [], questions: noul }, "state must be non-empty"],
    [{ state: {}, questions: noul }, "state must be non-empty"],
    [{ state: 3, questions: noul }, "object, array or string"],
    [{ state: "hi", questions: {} }, "non-empty object"],
    [{ state: "hi", questions: noul, stateTrim: [] }, "stateTrim"],
    [{ state: "hi", questions: noul, stateTrim: ["chat", ""] }, "stateTrim"],
  ])("rejects %j", (input, fragment) => {
    const result = validateDecisionRequest(input)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain(fragment)
  })

  it("refuses non-serializable state", () => {
    const state: Record<string, unknown> = { a: 1 }
    state.self = state
    const result = validateDecisionRequest({ state, questions: noul })
    expect(result).toEqual({ ok: false, message: "request must be JSON-serializable" })
  })

  it("refuses oversized requests", () => {
    const result = validateDecisionRequest({
      state: "x".repeat(MAX_DECISION_REQUEST_CHARS + 1),
      questions: noul,
    })
    expect(result.ok).toBe(false)
  })
})

describe("cross-realm payloads", () => {
  it("accepts plain objects from another realm and still rejects class instances", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { runInNewContext } = require("node:vm") as typeof import("node:vm")
    const foreign = runInNewContext('({ q: { type: "noul", instructions: "?" } })')
    expect(validateDecisionQuestions(foreign)).toBeNull()
    class Question {
      type = "noul"
      instructions = "?"
    }
    expect(validateDecisionQuestions({ q: new Question() })).toContain("must be an object")
  })
})
