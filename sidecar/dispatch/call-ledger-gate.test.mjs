import assert from "node:assert/strict"
import { test } from "node:test"

import {
  AI_SDK_USAGE_SEMANTICS,
  classifyCallError,
  createCallLedgerGate,
  drainSideCallStream,
  estimatePromptTokens,
  isDefinitiveRefusal,
  isLedgerStamp,
  isRetryableBeforeOutput,
  rawUsageFromAiSdk,
  refusalSessionEnded,
  runLedgeredSideCall,
} from "./call-ledger-gate.mjs"

const STAMP = {
  runId: "run-1",
  mode: "per_call",
  transportAttempts: 2,
  deploymentId: "openai:gpt-5",
}

function harness(ledger = STAMP, extra = {}) {
  const events = []
  let n = 0
  const gate = createCallLedgerGate({
    ledger,
    sessionId: "s1",
    emit: (event) => events.push(event),
    newId: () => `req-${++n}`,
    ...extra,
  })
  return { gate, events }
}

test("[ACC:OFF-04] a send without a ledger stamp is never gated", async () => {
  const { gate, events } = harness(null)
  assert.equal(gate.active, false)
  assert.deepEqual(await gate.reserve({ kind: "call", logicalStepId: "leg:1" }), {
    decision: "bypass",
    reason: "inactive",
  })
  gate.report({ attemptId: "a", status: "succeeded" })
  assert.deepEqual(events, [])
  assert.equal(isLedgerStamp({ runId: "", mode: "per_call" }), false)
  assert.equal(isLedgerStamp({ runId: "r", mode: "other" }), false)
})

test("asks before a call and resolves a grant", async () => {
  const { gate, events } = harness()
  const pending = gate.reserve({
    kind: "call",
    logicalStepId: "leg:1",
    estimatedInputTokens: 900,
    maxOutputTokens: 4096,
  })
  assert.deepEqual(events[0], {
    type: "call_reserve_request",
    sessionId: "s1",
    runId: "run-1",
    requestId: "req-1",
    kind: "call",
    logicalStepId: "leg:1",
    deploymentId: "openai:gpt-5",
    estimatedInputTokens: 900,
    maxOutputTokens: 4096,
  })
  assert.equal(
    gate.resolveDecision({
      requestId: "req-1",
      decision: "granted",
      attemptId: "att-1",
      attemptNo: 1,
    }),
    true
  )
  assert.deepEqual(await pending, { decision: "granted", attemptId: "att-1", attemptNo: 1 })
  assert.equal(gate.resolveDecision({ requestId: "req-1", decision: "granted" }), false)
  assert.equal(gate.transportAttempts, 2)
})

test("a refusal is returned as-is and keeps the gate active", async () => {
  const { gate } = harness()
  const pending = gate.reserve({ kind: "call", logicalStepId: "leg:1" })
  gate.resolveDecision({
    requestId: "req-1",
    decision: "refused",
    code: "RUN_BUDGET_EXHAUSTED",
    message: "cap",
  })
  assert.deepEqual(await pending, {
    decision: "refused",
    code: "RUN_BUDGET_EXHAUSTED",
    message: "cap",
  })
  assert.equal(gate.active, true)
  const ended = refusalSessionEnded("s1", { code: "RUN_BUDGET_EXHAUSTED" })
  assert.match(ended.error, /RUN_BUDGET_EXHAUSTED/)
  assert.deepEqual(ended.routerFusionRefusal, { code: "RUN_BUDGET_EXHAUSTED" })
})

test("[ACC:ISO-01] an unanswered reservation becomes a reported bypass, not a hang", async () => {
  const { gate, events } = harness(STAMP, { timeoutMs: 5 })
  const outcome = await gate.reserve({ kind: "call", logicalStepId: "leg:1" })
  assert.deepEqual(outcome, { decision: "bypass", reason: "renderer_unanswered" })
  assert.equal(gate.active, false)
  assert.deepEqual(events.at(-1), {
    type: "ledger_bypassed",
    sessionId: "s1",
    runId: "run-1",
    reason: "renderer_unanswered",
  })
  // Later calls go straight through without asking again.
  assert.equal((await gate.reserve({ kind: "call", logicalStepId: "leg:2" })).decision, "bypass")
  assert.equal(events.filter((e) => e.type === "call_reserve_request").length, 1)
})

test("a renderer bypass answer stops gating the rest of the turn", async () => {
  const { gate, events } = harness()
  const pending = gate.reserve({ kind: "call", logicalStepId: "leg:1" })
  gate.resolveDecision({ requestId: "req-1", decision: "bypass", code: "db_unavailable" })
  assert.deepEqual(await pending, { decision: "bypass", reason: "db_unavailable" })
  assert.equal(gate.active, false)
  assert.equal(events.filter((e) => e.type === "ledger_bypassed").length, 1)
})

test("reports results with usage semantics and drains on close", async () => {
  const { gate, events } = harness()
  gate.report({
    attemptId: "att-1",
    logicalStepId: "leg:1",
    status: "succeeded",
    usage: { inputTokens: 10, outputTokens: 5 },
    providerRequestId: "resp_1",
    finishReason: "stop",
  })
  assert.deepEqual(events[0], {
    type: "call_attempt_result",
    sessionId: "s1",
    runId: "run-1",
    attemptId: "att-1",
    logicalStepId: "leg:1",
    status: "succeeded",
    usage: { inputTokens: 10, outputTokens: 5 },
    semantics: AI_SDK_USAGE_SEMANTICS,
    providerRequestId: "resp_1",
    finishReason: "stop",
  })
  const pending = gate.reserve({ kind: "call", logicalStepId: "leg:2" })
  gate.drain("closed")
  assert.deepEqual(await pending, {
    decision: "refused",
    code: "SESSION_CLOSED",
    message: "closed",
  })
})

test("normalizes AI SDK usage without inventing unreported fields", () => {
  assert.equal(rawUsageFromAiSdk(null), null)
  assert.equal(rawUsageFromAiSdk({}), null)
  assert.deepEqual(rawUsageFromAiSdk({ inputTokens: 100, outputTokens: 20 }), {
    inputTokens: 100,
    outputTokens: 20,
  })
  assert.deepEqual(
    rawUsageFromAiSdk({
      inputTokens: { total: 100, cacheRead: 40, cacheWrite: 10 },
      outputTokens: { total: 20, reasoning: 5 },
    }),
    {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 40,
      cacheWriteTokens: 10,
      reasoningTokens: 5,
    }
  )
})

test("classifies call errors by what they say about billing", () => {
  assert.equal(classifyCallError({ status: 429 }), "rate_limited")
  assert.equal(classifyCallError({ statusCode: 503 }), "server_error")
  assert.equal(classifyCallError({ status: 401 }), "auth")
  assert.equal(classifyCallError({ status: 400 }), "invalid_request")
  assert.equal(classifyCallError({ code: "ECONNREFUSED" }), "not_sent")
  assert.equal(classifyCallError({ cause: { code: "ENOTFOUND" } }), "not_sent")
  assert.equal(classifyCallError(new Error("socket hang up")), "timeout_after_send")
  assert.equal(classifyCallError(new Error("x"), { aborted: true }), "cancelled")
  assert.equal(isRetryableBeforeOutput("rate_limited"), true)
  // Sent-but-silent is retried (watchdog timeout, socket hangup) — the attempt
  // is still booked UNKNOWN, retried ≠ assumed free.
  assert.equal(isRetryableBeforeOutput("timeout_after_send"), true)
  assert.equal(isRetryableBeforeOutput("refusal"), false)
  // Bookkeeping split: a retried timeout was possibly charged, so it is not a
  // definitive refusal — it reports UNKNOWN, unlike a pre-processing refusal.
  assert.equal(isDefinitiveRefusal("timeout_after_send"), false)
  assert.equal(isDefinitiveRefusal("rate_limited"), true)
  assert.equal(isDefinitiveRefusal("auth"), true)
})

test("estimates prompt tokens conservatively", () => {
  assert.equal(estimatePromptTokens(["abcdef", null, { a: 1 }]), Math.ceil((6 + 7) / 3))
})

function fakeRun(parts, { usage, responseId } = {}) {
  return {
    fullStream: (async function* () {
      for (const part of parts) yield part
    })(),
    get usage() {
      return usage instanceof Error ? Promise.reject(usage) : Promise.resolve(usage)
    },
    get response() {
      return Promise.resolve(responseId ? { id: responseId } : {})
    },
  }
}

test("[ACC:OFF-04] a side call without an active gate reads text only, as before", async () => {
  let usageRead = false
  const run = fakeRun([
    { type: "text-delta", text: "sum" },
    { type: "error", error: new Error("x") },
  ])
  Object.defineProperty(run, "usage", {
    get() {
      usageRead = true
      return Promise.resolve(undefined)
    },
  })
  const outcome = await runLedgeredSideCall(null, { logicalStepId: "compact:1" }, () =>
    drainSideCallStream(run, { withBilling: false })
  )
  assert.deepEqual(outcome, { sent: true, value: "sum" })
  assert.equal(usageRead, false)
})

test("a side call in a ledgered turn is reserved on its own deployment and settled", async () => {
  const { gate, events } = harness()
  const pending = runLedgeredSideCall(
    gate,
    {
      logicalStepId: "compact:1",
      deploymentId: "anthropic::claude-haiku",
      estimatedInputTokens: 300,
      maxOutputTokens: 500,
    },
    () =>
      drainSideCallStream(
        fakeRun([{ type: "text-delta", text: "summary" }], {
          usage: { inputTokens: 280, outputTokens: 90 },
          responseId: "msg_1",
        }),
        { withBilling: true }
      )
  )
  await Promise.resolve()
  assert.equal(events[0].deploymentId, "anthropic::claude-haiku")
  assert.equal(events[0].maxOutputTokens, 500)
  gate.resolveDecision({
    requestId: "req-1",
    decision: "granted",
    attemptId: "att-9",
    attemptNo: 1,
  })
  assert.deepEqual(await pending, { sent: true, value: "summary" })
  assert.deepEqual(events[1], {
    type: "call_attempt_result",
    sessionId: "s1",
    runId: "run-1",
    attemptId: "att-9",
    logicalStepId: "compact:1",
    status: "succeeded",
    usage: { inputTokens: 280, outputTokens: 90 },
    semantics: AI_SDK_USAGE_SEMANTICS,
    providerRequestId: "msg_1",
  })
})

test("a refused side call sends nothing", async () => {
  const { gate, events } = harness()
  let sent = false
  const pending = runLedgeredSideCall(gate, { logicalStepId: "optical:1" }, async () => {
    sent = true
    return { value: "" }
  })
  await Promise.resolve()
  gate.resolveDecision({ requestId: "req-1", decision: "refused", code: "BUDGET_EXHAUSTED" })
  assert.deepEqual(await pending, { sent: false, refusal: { code: "BUDGET_EXHAUSTED" } })
  assert.equal(sent, false)
  assert.equal(events.length, 1)
})

test("a side call that broke after sending is UNKNOWN; a refused one is failed", async () => {
  const { gate, events } = harness()
  const hangUp = runLedgeredSideCall(gate, { logicalStepId: "compact:1" }, () =>
    drainSideCallStream(
      fakeRun([{ type: "error", error: new Error("socket hang up") }], {
        usage: new Error("no usage"),
      }),
      {
        withBilling: true,
      }
    )
  )
  await Promise.resolve()
  gate.resolveDecision({
    requestId: "req-1",
    decision: "granted",
    attemptId: "att-1",
    attemptNo: 1,
  })
  assert.deepEqual(await hangUp, { sent: true, value: "" })
  assert.equal(events[1].status, "unknown")
  assert.equal(events[1].errorClass, "timeout_after_send")

  const limited = runLedgeredSideCall(gate, { logicalStepId: "compact:2" }, async () => {
    throw Object.assign(new Error("slow down"), { status: 429 })
  })
  await Promise.resolve()
  gate.resolveDecision({
    requestId: "req-2",
    decision: "granted",
    attemptId: "att-2",
    attemptNo: 1,
  })
  await assert.rejects(limited, /slow down/)
  assert.equal(events[3].status, "failed")
  assert.equal(events[3].errorClass, "rate_limited")
})
