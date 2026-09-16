import {
  ChatResponseSchema,
  RunRequestSchema,
  type ChatRequest,
  type RunResult,
} from "../contracts/schemas"
import {
  chatFailureStatus,
  chatResponseOf,
  chatRunInputOf,
  RUN_INPUT_MESSAGE_LIMIT,
} from "./chat-compat"
import { parseChatCompatRequest, type RunRequestPolicy } from "./request-rules"

const POLICY: RunRequestPolicy = {
  trackedBudgetEnabled: true,
  maxRunCapMicrousd: () => 2_000_000,
  workspaceAuthorized: () => false,
  acceptanceProfileExists: () => false,
  minimumProfile: "economy",
  degradeAllowed: true,
}
const EXECUTABLE = ["direct", "cascade", "panel"] as const

function chat(overrides: Record<string, unknown> = {}): ChatRequest {
  const parsed = parseChatCompatRequest({
    model: "cognia/panel",
    messages: [
      { role: "system", content: "Answer in one sentence." },
      { role: "user", content: "What was the 2024 steel tariff?" },
      { role: "assistant", content: "2%." },
      { role: "user", content: "And in 2025?" },
    ],
    routing: {
      profile: "balanced",
      budget: { max_cost_usd: "1.000000", mode: "tracked" },
      deadline_ms: 120000,
      allow_degraded: false,
    },
    ...overrides,
  })
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues))
  return parsed.value
}

describe("chatRunInputOf", () => {
  it("turns a compat call into a validated run whose input is the whole conversation", () => {
    const mapped = chatRunInputOf(chat(), EXECUTABLE, POLICY)
    if (!mapped.ok) throw new Error(JSON.stringify(mapped.issues))
    expect(RunRequestSchema.parse(mapped.value.request)).toEqual(mapped.value.request)
    expect(mapped.value.request).toMatchObject({
      mode: "panel",
      allowed_modes: ["panel"],
      profile: "balanced",
      budget: { max_cost_usd: "1.000000", mode: "tracked" },
      deadline_ms: 120000,
      allow_degraded: false,
      delivery: "verified_buffered",
      input_messages: [
        { role: "user", content: "What was the 2024 steel tariff?" },
        { role: "user", content: "And in 2025?" },
      ],
    })
    expect(mapped.value.request.session_id).toBeUndefined()
    expect(mapped.value.messages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
    ])
    expect(mapped.value.jsonSchema).toBeNull()
  })

  it("lets auto choose only among the modes this build executes, never delegate", () => {
    const mapped = chatRunInputOf(
      chat({ model: "cognia/auto" }),
      ["direct", "panel", "delegate"],
      POLICY
    )
    expect(mapped.ok && mapped.value.request).toMatchObject({
      mode: "auto",
      allowed_modes: ["direct", "panel"],
    })
    expect(chatRunInputOf(chat({ model: "cognia/auto" }), ["delegate"], POLICY)).toMatchObject({
      ok: false,
      issues: [{ code: "MODE_NOT_ALLOWED" }],
    })
  })

  it("keeps the newest user turns when there are more than a run request holds", () => {
    const messages = Array.from({ length: RUN_INPUT_MESSAGE_LIMIT + 5 }, (_, i) => ({
      role: "user",
      content: `turn ${i}`,
    }))
    const mapped = chatRunInputOf(chat({ messages }), EXECUTABLE, POLICY)
    if (!mapped.ok) throw new Error("refused")
    expect(mapped.value.request.input_messages).toHaveLength(RUN_INPUT_MESSAGE_LIMIT)
    expect(mapped.value.request.input_messages[0].content).toBe("turn 5")
    expect(mapped.value.messages).toHaveLength(RUN_INPUT_MESSAGE_LIMIT + 5)
  })

  it("carries a structured answer's schema, and refuses a json_schema format without one", () => {
    const schema = { type: "object", required: ["rate"], properties: { rate: { type: "number" } } }
    const mapped = chatRunInputOf(
      chat({ response_format: { type: "json_schema", json_schema: schema } }),
      EXECUTABLE,
      POLICY
    )
    expect(mapped.ok && mapped.value.jsonSchema).toEqual(schema)
    expect(
      chatRunInputOf(chat({ response_format: { type: "json_schema" } }), EXECUTABLE, POLICY)
    ).toMatchObject({
      ok: false,
      issues: [{ code: "SCHEMA_INVALID", details: { paths: ["response_format.json_schema"] } }],
    })
    const text = chatRunInputOf(chat({ response_format: { type: "text" } }), EXECUTABLE, POLICY)
    expect(text.ok && text.value.jsonSchema).toBeNull()
  })

  it("refuses a conversation with nothing to answer", () => {
    expect(
      chatRunInputOf(
        chat({ messages: [{ role: "system", content: "be brief" }] }),
        EXECUTABLE,
        POLICY
      )
    ).toMatchObject({ ok: false, issues: [{ code: "SCHEMA_INVALID" }] })
  })

  it("holds a compat call to the same account policy as a run request", () => {
    const strictOnly = { ...POLICY, trackedBudgetEnabled: false, degradeAllowed: false }
    const mapped = chatRunInputOf(
      chat({
        routing: {
          profile: "balanced",
          budget: { max_cost_usd: "9.000000", mode: "tracked" },
          deadline_ms: 120000,
          allow_degraded: true,
        },
      }),
      EXECUTABLE,
      strictOnly
    )
    expect(mapped.ok ? [] : mapped.issues.map((issue) => issue.code)).toEqual([
      "BUDGET_MODE_NOT_ENABLED",
      "BUDGET_ABOVE_LIMIT",
      "DEGRADE_NOT_PERMITTED",
    ])
  })
})

describe("chatResponseOf", () => {
  const result: RunResult = {
    answer: "The 2025 steel tariff is 4%.",
    answer_artifact_id: "11111111-1111-4111-8111-111111111111",
    answer_sha256: "a".repeat(64),
    mode_executed: "panel",
    quality_status: "degraded",
    verification: {
      schema_version: "1.0.0",
      report_id: "22222222-2222-4222-8222-222222222222",
      status: "inconclusive",
      level: "mixed",
      checks: [],
      revision: null,
      verifier_version: "v",
      artifact_refs: [],
    },
    delivery: "answer",
    artifact_ids: [],
    warnings: ["degraded:single_candidate"],
  }

  it("answers in the contract's shape, echoing the model the caller asked for", () => {
    const response = chatResponseOf({
      runId: "33333333-3333-4333-8333-333333333333",
      model: "cognia/panel",
      createdAtMs: 1_800_000_000_999,
      result,
      billing: {
        budget_cap_microusd: 1_000_000,
        spent_microusd: 12_345,
        active_step_reservations_microusd: 0,
        tenant_hold_microusd: 0,
        status: "actual",
        overspend_microusd: 0,
        model_calls: 5,
      },
      usage: { promptTokens: 1200, completionTokens: 300 },
    })
    expect(ChatResponseSchema.parse(response)).toEqual(response)
    expect(response).toMatchObject({
      id: "chatcmpl-33333333-3333-4333-8333-333333333333",
      created: 1_800_000_000,
      model: "cognia/panel",
      choices: [
        { index: 0, message: { role: "assistant", content: result.answer }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500 },
      routing: { mode_executed: "panel", degraded: true, billing: { spent_microusd: 12_345 } },
    })
  })
})

describe("chatFailureStatus", () => {
  it("sorts a run's failure into the statuses the compat endpoint has", () => {
    expect(chatFailureStatus("RUN_BUDGET_EXHAUSTED")).toBe(409)
    expect(chatFailureStatus("SESSION_BUSY")).toBe(409)
    expect(chatFailureStatus("VERIFICATION_FAILED")).toBe(422)
    expect(chatFailureStatus("POLICY_REFUSAL")).toBe(422)
    expect(chatFailureStatus("RATE_LIMITED")).toBe(429)
    expect(chatFailureStatus("CALL_OUTCOME_UNKNOWN")).toBe(503)
    expect(chatFailureStatus("DEADLINE_EXCEEDED")).toBe(503)
    expect(chatFailureStatus("something new")).toBe(503)
  })
})
