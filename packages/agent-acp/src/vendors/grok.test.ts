import type { AcpElicitationValue } from "@cognia/agent-contracts/external-agent"
import { grokAcpProfile } from "./grok"

const extension = grokAcpProfile.elicitationExtensions!["_x.ai/ask_user_question"]
const params = () => ({
  sessionId: "s",
  toolCallId: "tc",
  mode: "default",
  questions: [
    {
      question: "Which database?",
      options: [
        { label: "Postgres", description: "Relational", preview: "SELECT 1" },
        { label: "Redis", description: "In-memory" },
      ],
      multiSelect: false,
    },
    {
      question: "Which features?",
      options: [
        { label: "A", description: "First" },
        { label: "B", description: "Second" },
      ],
      multiSelect: true,
    },
  ],
})

describe("grokAcpProfile", () => {
  it("projects questions and optional notes into the existing form schema", () => {
    expect(extension.request(params())).toMatchObject({
      sessionId: "s",
      toolCallId: "tc",
      mode: "form",
      requestedSchema: {
        properties: {
          q0: {
            type: "string",
            oneOf: [
              { const: "Postgres", title: "Postgres" },
              { const: "Redis", title: "Redis" },
            ],
          },
          q1: { type: "array", items: { type: "string" } },
          q0_notes: { type: "string", format: "multiline" },
        },
      },
      _meta: {
        userInput: {
          questions: [
            { id: "q0", notesField: "q0_notes", multiple: false, isOther: true },
            { id: "q1", notesField: "q1_notes", multiple: true, isOther: true },
          ],
        },
      },
    })
  })

  it("preserves selections, verbatim notes and single-selection previews", () => {
    expect(
      extension.response(
        {
          action: "accept",
          content: {
            q0: "Postgres",
            q0_notes: " Keep it local ",
            q1: ["A", "B"],
          },
        },
        params()
      )
    ).toEqual({
      outcome: "accepted",
      answers: {
        "Which database?": ["Postgres"],
        "Which features?": ["A", "B"],
      },
      annotations: { "Which database?": { notes: " Keep it local ", preview: "SELECT 1" } },
    })
  })

  it("prunes only unselected radio defaults before shared enum validation", () => {
    const response = {
      requestId: "81",
      action: "accept" as const,
      content: { q0: "", q0_notes: "SQLite", q1: [], q1_notes: "Neither" },
    }
    expect(extension.prepareResponse!(response, params())).toEqual({
      ...response,
      content: { q0_notes: "SQLite", q1: [], q1_notes: "Neither" },
    })
    expect(response.content.q0).toBe("")
    const invalid = { ...response, content: { ...response.content, q0: "unknown" } }
    expect(extension.prepareResponse!(invalid, params()).content?.q0).toBe("unknown")
  })

  it("uses the upstream Other convention for freeform-only answers", () => {
    expect(
      extension.response(
        {
          action: "accept",
          content: {
            q0_notes: "SQLite",
            q1_notes: "Neither",
          },
        },
        params()
      )
    ).toEqual({
      outcome: "accepted",
      answers: {
        "Which database?": ["Other"],
        "Which features?": ["Other"],
      },
      annotations: {
        "Which database?": { notes: "SQLite" },
        "Which features?": { notes: "Neither" },
      },
    })
  })

  it.each<Record<string, AcpElicitationValue>>([
    {},
    { q0: "Postgres" },
    { q0_notes: "  ", q1: ["A"] },
    { q0: "Unknown", q1: ["A"] },
    { q0: ["Postgres", "Redis"], q1: ["A"] },
    { q0: "Postgres", q1: ["A", "A"] },
    { q0: "Postgres", q1_notes: 4 },
  ])("fails closed on incomplete or invalid answers %j", (content) => {
    expect(extension.response({ action: "accept", content }, params())).toEqual({
      outcome: "cancelled",
    })
  })

  it.each(["decline", "cancel"] as const)("maps %s to native cancellation", (action) => {
    expect(extension.response({ action }, params())).toEqual({ outcome: "cancelled" })
  })

  it.each([
    undefined,
    {},
    { ...params(), sessionId: "" },
    { ...params(), questions: [] },
    { ...params(), mode: "unknown" },
    { ...params(), questions: [params().questions[0], params().questions[0]] },
    { ...params(), questions: [{ ...params().questions[0], options: [{ label: "A" }] }] },
    { ...params(), questions: [{ ...params().questions[0], multiSelect: "true" }] },
  ])("rejects malformed request %j", (value) => {
    expect(() => extension.request(value)).toThrow("Invalid Grok user question")
  })

  it("preserves prompt aggregates and real zero counters without inventing costs", () => {
    expect(
      grokAcpProfile.promptUsage!({
        _meta: {
          inputTokens: 1,
          usage: {
            inputTokens: 207,
            outputTokens: 14,
            totalTokens: 221,
            cachedReadTokens: 50,
            cacheCreationTokens: 0,
            reasoningTokens: 4,
          },
        },
      })
    ).toEqual({
      promptTokens: 207,
      completionTokens: 14,
      totalTokens: 221,
      cacheReadTokens: 50,
      cacheWriteTokens: 0,
      reasoningTokens: 4,
    })
    expect(
      grokAcpProfile.promptUsage!({
        _meta: {
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
          },
        },
      })
    ).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0 })
  })

  it.each([
    undefined,
    {},
    { inputTokens: 1, outputTokens: 2 },
    { inputTokens: -1, outputTokens: 2, totalTokens: 1 },
    { inputTokens: 1, outputTokens: Number.NaN, totalTokens: 2 },
    { inputTokens: 1, outputTokens: 2, totalTokens: 3, cachedReadTokens: "1" },
  ])("does not manufacture usage from absent or malformed aggregate %j", (usage) => {
    expect(
      grokAcpProfile.promptUsage!({ _meta: { usage, inputTokens: 99, outputTokens: 5 } })
    ).toBeUndefined()
  })
})
