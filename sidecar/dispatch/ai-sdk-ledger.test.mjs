// Router + Fusion (ADR-0188) call gating in the AI SDK dispatcher. A fake
// `streamText` stands in for the provider; the test plays the renderer by
// answering `call_reserve_request` frames through `session.resolveCallReserve`.

import assert from "node:assert/strict"
import { test } from "node:test"

import { dispatchAiSdk } from "./ai-sdk.mjs"

const STAMP = {
  runId: "run-1",
  mode: "per_call",
  transportAttempts: 2,
  deploymentId: "openai:gpt-x",
}

function scriptedStream(script) {
  const calls = []
  const fn = (args) => {
    const index = calls.length
    calls.push(args)
    const leg = script[Math.min(index, script.length - 1)]
    return {
      fullStream: (async function* () {
        for (const e of leg.events) yield e
      })(),
      usage:
        leg.usage === undefined
          ? Promise.resolve({ inputTokens: 100, outputTokens: 10 })
          : Promise.resolve(leg.usage),
      response: Promise.resolve({ id: `resp_${index}`, messages: [] }),
      steps: Promise.resolve([{}]),
    }
  }
  return { calls, fn }
}

function harness({ sendOptions = {}, script, decide }) {
  const events = []
  const stream = scriptedStream(script)
  let session
  let attempts = 0
  const emit = (msg) => {
    events.push(msg)
    // Stand in for the renderer's plugin bus (the PreCompact hook), so a
    // compaction test does not wait out the 5 s fallback timeout.
    if (msg.type === "plugin_hook_exec") {
      setImmediate(() => session.pendingPluginHookCalls.get(msg.execId)?.resolve({ result: {} }))
    }
    if (msg.type === "call_reserve_request") {
      const decision = decide ? decide(msg) : { decision: "granted" }
      setImmediate(() => {
        if (decision.decision === "granted") attempts += 1
        session.resolveCallReserve({
          requestId: msg.requestId,
          ...decision,
          ...(decision.decision === "granted"
            ? { attemptId: `att-${attempts}`, attemptNo: decision.attemptNo ?? 1 }
            : {}),
        })
      })
    }
  }
  session = dispatchAiSdk({
    provider: "openai",
    sessionId: "s1",
    firstPrompt: "hello",
    sendOptions: {
      model: "gpt-x",
      providerCredentials: { apiKey: "k", protocol: "openai" },
      builtinTools: { coreFiles: true },
      ...sendOptions,
    },
    emit,
    log: () => {},
    streamText: stream.fn,
  })
  return { events, stream, session }
}

function waitFor(events, predicate, count = 1) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = () => {
      if (events.filter(predicate).length >= count) return resolve()
      if (Date.now() - started > 3000) return reject(new Error("timed out waiting for event"))
      setTimeout(tick, 2)
    }
    tick()
  })
}

const ended = (e) => e.type === "session_ended"
const STOP = {
  events: [
    { type: "text-delta", text: "done" },
    { type: "finish", finishReason: "stop" },
  ],
}

test("[ACC:OFF-04] a turn without a ledger stamp keeps the legacy leg size and SDK retries", async () => {
  const { events, stream, session } = harness({ script: [STOP] })
  await waitFor(events, ended)
  const call = stream.calls[0]
  assert.equal("maxRetries" in call, false)
  assert.equal(call.stopWhen({ steps: new Array(15) }), false)
  assert.equal(call.stopWhen({ steps: new Array(16) }), true)
  assert.equal(
    events.some((e) => e.type === "call_reserve_request" || e.type === "call_attempt_result"),
    false
  )
  session.closeInput()
})

test("reserves every model call, one per leg, with SDK retries off", async () => {
  const { events, stream, session } = harness({
    sendOptions: { ledger: STAMP },
    script: [
      {
        events: [
          { type: "tool-call", toolCallId: "t1", toolName: "x", input: {} },
          { type: "finish", finishReason: "tool-calls" },
        ],
      },
      STOP,
    ],
  })
  await waitFor(events, ended)
  const reserves = events.filter((e) => e.type === "call_reserve_request")
  assert.deepEqual(
    reserves.map((r) => [r.kind, r.logicalStepId, r.runId, r.deploymentId]),
    [
      ["call", "leg:0", "run-1", "openai:gpt-x"],
      ["call", "leg:1", "run-1", "openai:gpt-x"],
    ]
  )
  assert.ok(reserves[0].estimatedInputTokens > 0)
  assert.equal(stream.calls.length, 2)
  for (const call of stream.calls) {
    assert.equal(call.maxRetries, 0)
    assert.equal(call.stopWhen({ steps: new Array(1) }), true)
  }
  const results = events.filter((e) => e.type === "call_attempt_result")
  assert.deepEqual(
    results.map((r) => [
      r.attemptId,
      r.logicalStepId,
      r.status,
      r.providerRequestId,
      r.finishReason,
    ]),
    [
      ["att-1", "leg:0", "succeeded", "resp_0", "tool_calls"],
      ["att-2", "leg:1", "succeeded", "resp_1", "stop"],
    ]
  )
  assert.deepEqual(results[0].usage, { inputTokens: 100, outputTokens: 10 })
  // Each reservation precedes its call's result.
  assert.ok(events.indexOf(reserves[1]) > events.indexOf(results[0]))
  session.closeInput()
})

test("a refused reservation sends nothing and ends the turn explicitly", async () => {
  const { events, stream, session } = harness({
    sendOptions: { ledger: STAMP },
    script: [STOP],
    decide: () => ({ decision: "refused", code: "RUN_BUDGET_EXHAUSTED", message: "cap reached" }),
  })
  await waitFor(events, ended)
  assert.equal(stream.calls.length, 0)
  const end = events.find(ended)
  assert.deepEqual(end.routerFusionRefusal, {
    code: "RUN_BUDGET_EXHAUSTED",
    message: "cap reached",
  })
  assert.match(end.error, /RUN_BUDGET_EXHAUSTED/)
  session.closeInput()
})

test("an explicit pre-output 429 is booked failed and retried as a new reserved attempt", async () => {
  const rateLimited = {
    status: 429,
    message: "rate limited",
    responseHeaders: { "retry-after": "0" },
  }
  const { events, stream, session } = harness({
    sendOptions: { ledger: STAMP },
    script: [{ events: [{ type: "error", error: rateLimited }], usage: null }, STOP],
    decide: (msg) => ({
      decision: "granted",
      attemptNo: events.filter(
        (e) => e.type === "call_reserve_request" && e.logicalStepId === msg.logicalStepId
      ).length,
    }),
  })
  await waitFor(events, ended)
  const reserves = events.filter((e) => e.type === "call_reserve_request")
  assert.deepEqual(
    reserves.map((r) => r.logicalStepId),
    ["leg:0", "leg:0"]
  )
  const results = events.filter((e) => e.type === "call_attempt_result")
  assert.deepEqual(
    results.map((r) => [r.attemptId, r.status, r.errorClass ?? null]),
    [
      ["att-1", "failed", "rate_limited"],
      ["att-2", "succeeded", null],
    ]
  )
  assert.equal(stream.calls.length, 2)
  assert.equal(events.find(ended).error, undefined)
  session.closeInput()
})

test("a timeout with no output is UNKNOWN and never retried", async () => {
  const { events, stream, session } = harness({
    sendOptions: { ledger: STAMP },
    script: [{ events: [{ type: "error", error: new Error("socket hang up") }], usage: null }],
  })
  await waitFor(events, ended)
  const results = events.filter((e) => e.type === "call_attempt_result")
  assert.deepEqual(
    results.map((r) => [r.status, r.errorClass]),
    [["unknown", "timeout_after_send"]]
  )
  assert.equal(stream.calls.length, 1)
  session.closeInput()
})

test("[ACC:ISO-01] a renderer bypass continues the turn unledgered with default retries", async () => {
  const { events, stream, session } = harness({
    sendOptions: { ledger: STAMP },
    script: [STOP],
    decide: () => ({ decision: "bypass", code: "db_unavailable" }),
  })
  await waitFor(events, ended)
  assert.equal(stream.calls.length, 1)
  assert.equal("maxRetries" in stream.calls[0], false)
  assert.equal(events.filter((e) => e.type === "ledger_bypassed").length, 1)
  assert.equal(
    events.some((e) => e.type === "call_attempt_result"),
    false
  )
  session.closeInput()
})

test("a refused compaction summary is skipped, not sent, and never fails the turn", async () => {
  // Real input tokens above the trigger (0.1 × 128k = 12,800).
  const big = { ...STOP, usage: { inputTokens: 50_000, outputTokens: 3 } }
  const { events, session } = harness({
    sendOptions: {
      ledger: STAMP,
      compaction: {
        enabled: true,
        keepRecent: 2,
        fraction: 0.1,
        strategy: "summary",
        maxSummaryTokens: 64,
        summaryPrompt: "SUMMARIZE",
      },
    },
    script: [big],
    decide: (msg) =>
      msg.logicalStepId.startsWith("compact:")
        ? { decision: "refused", code: "RUN_BUDGET_EXHAUSTED", message: "cap reached" }
        : { decision: "granted" },
  })
  await waitFor(events, ended)
  // Compaction runs at the head of the NEXT turn, which needs its own stamp.
  session.setNextTurnLedger({ ...STAMP, runId: "run-2" })
  session.pushUserMessage("m1")
  await waitFor(events, ended, 2)
  session.closeInput()

  const compactions = events.filter(
    (e) => e.type === "call_reserve_request" && e.logicalStepId.startsWith("compact:")
  )
  assert.equal(compactions.length, 1)
  assert.equal(compactions[0].deploymentId, "openai::gpt-x")
  assert.ok(compactions[0].estimatedInputTokens > 0)
  assert.equal(compactions[0].maxOutputTokens, 64)
  // A refused summary is never sent, so the transcript is left uncompacted…
  assert.equal(
    events.some((e) => e.type === "event" && e.event?.subtype === "compact_boundary"),
    false
  )
  // …and the turn it rode on still finished normally.
  assert.equal(
    events.filter(ended).every((e) => e.error === undefined),
    true
  )
})

test("an optical compaction's read-back call is reserved like any other model call", async () => {
  const LONG =
    "the assistant refactored the authentication module to use rotating refresh tokens and updated the co located unit tests across several files without regressions. ".repeat(
      4
    )
  const big = {
    events: [
      { type: "text-delta", text: LONG },
      { type: "finish", finishReason: "stop" },
    ],
    usage: { inputTokens: 50_000, outputTokens: 3 },
  }
  const { events, session } = harness({
    sendOptions: {
      ledger: STAMP,
      // Resolves to the anthropic vision family → cheap frame estimate.
      model: "claude-test",
      compaction: {
        enabled: true,
        keepRecent: 2,
        fraction: 0.1,
        strategy: "optical",
        // `verify` left on: the read-back is the call under test.
        optical: { size: 512 },
      },
    },
    script: [big],
  })
  await waitFor(events, ended)
  session.setNextTurnLedger({ ...STAMP, runId: "run-2" })
  session.pushUserMessage(LONG)
  await waitFor(events, ended, 2)
  session.setNextTurnLedger({ ...STAMP, runId: "run-3" })
  session.pushUserMessage(LONG)
  await waitFor(events, ended, 3)
  session.closeInput()

  const reads = events.filter(
    (e) => e.type === "call_reserve_request" && e.logicalStepId.startsWith("optical:")
  )
  assert.ok(reads.length >= 1, "the vision read-back is reserved")
  assert.equal(reads[0].deploymentId, "openai::claude-test")
  assert.equal(reads[0].maxOutputTokens, 1024)
  // The image is billed as input the text estimate cannot see.
  assert.ok(reads[0].estimatedInputTokens > 0)
  const settled = events.filter(
    (e) => e.type === "call_attempt_result" && e.logicalStepId === reads[0].logicalStepId
  )
  assert.equal(settled.length, 1)
})

test("each send brings its own ledger stamp into the live session", async () => {
  const { events, stream, session } = harness({ sendOptions: { ledger: STAMP }, script: [STOP] })
  await waitFor(events, ended)
  // Second send: switched off — no stamp.
  session.setNextTurnLedger(undefined)
  session.pushUserMessage("again")
  await waitFor(events, ended, 2)
  assert.equal(events.filter((e) => e.type === "call_reserve_request").length, 1)
  assert.equal("maxRetries" in stream.calls[1], false)
  // Third send: on again, a new run.
  session.setNextTurnLedger({ ...STAMP, runId: "run-2" })
  session.pushUserMessage("third")
  await waitFor(events, ended, 3)
  const reserves = events.filter((e) => e.type === "call_reserve_request")
  assert.deepEqual(
    reserves.map((r) => r.runId),
    ["run-1", "run-2"]
  )
  session.closeInput()
})
