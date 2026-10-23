import { test } from "node:test"
import assert from "node:assert/strict"
import { createCompactor, type CompactionState } from "./compaction.ts"
import { makeSummaryMessage, type ConversationMessage } from "../../context/compaction.ts"
import type { PendingPluginHooks } from "../../hooks/kernel/types.ts"
import type { SendOptions } from "../../shared/wire/inbound.ts"
import { createCallLedgerGate } from "../common/call-ledger-gate.ts"
import { estimatePromptTokens } from "../common/call-ledger-gate.ts"
import type { ProtocolAdapter } from "../../providers/protocol-adapters/types.ts"
import {
  parseProgressCheckpoint,
  renderProgressCheckpoint,
} from "../../context/progress-checkpoint.ts"

function fixture(
  options: {
    compaction?: SendOptions["compaction"]
    provider?: string
    model?: string
    effort?: SendOptions["effort"]
    answerHook?: boolean
    hookContext?: () => string
    fail?: boolean
    /** Stream parts for the Nth (1-based) summary call; default one text delta. */
    script?: (call: number) => Record<string, unknown>[]
    hostRpc?: Parameters<typeof createCompactor>[0]["hostRpc"]
    streamTextOverride?: Parameters<typeof createCompactor>[0]["streamTextOverride"]
  } = {}
) {
  let complete!: () => void
  let started!: () => void
  const summaryStarted = new Promise<void>((resolve) => {
    started = resolve
  })
  const gate = new Promise<void>((resolve) => {
    complete = resolve
  })
  const events: Record<string, unknown>[] = []
  const pendingHooks: PendingPluginHooks = new Map()
  const conversation: ConversationMessage[] = Array.from({ length: 8 }, (_, i) => ({
    role: i % 2 ? "assistant" : "user",
    content: `message ${i} ${"source evidence ".repeat(12)}`,
  }))
  const state: CompactionState = {
    model: options.model ?? "test",
    lastInputTokens: 700,
    frozenSummaryVersion: 0,
    ledgerSideCalls: 0,
    turnLedgerGate: null,
    activeAbortController: new AbortController(),
  }
  let calls = 0
  let signal: AbortSignal | undefined
  const starts: Parameters<ProtocolAdapter["start"]>[0][] = []
  const adapter: ProtocolAdapter = {
    id:
      options.provider === "deepseek"
        ? "ai-sdk:openai"
        : options.provider === "anthropic"
          ? "ai-sdk:anthropic"
          : "test",
    async start(args) {
      calls++
      const call = calls
      starts.push(args)
      signal = args.abortSignal
      started()
      return {
        fullStream: (async function* () {
          await gate
          if (options.fail) throw new Error("synthetic provider failure")
          if (options.script) yield* options.script(call)
          else yield { type: "text-delta", text: "prepared summary" }
        })(),
      }
    },
  }
  const compact = createCompactor({
    state,
    conversation,
    sendOptions: {
      agentKind: "subagent",
      agentRef: "Plan",
      ...(options.effort ? { effort: options.effort } : {}),
      compaction: {
        background: true,
        contextWindow: 1000,
        fraction: 0.8,
        keepRecent: 2,
        captureUndoSnapshot: true,
        ...options.compaction,
      },
    },
    provider: options.provider ?? "test",
    sessionId: "s",
    sdkSessionId: "sdk",
    protocolAdapter: adapter,
    hostRpc: options.hostRpc,
    streamTextOverride: options.streamTextOverride,
    pendingProtocolExecs: new Map(),
    pendingPluginHookCalls: pendingHooks,
    emit(event) {
      if (event.type === "plugin_hook_exec") {
        if (options.answerHook !== false)
          pendingHooks.get(String(event.execId))?.resolve({
            result: options.hookContext ? { contextToInject: options.hookContext() } : {},
          })
      } else events.push(event)
    },
    log() {},
    isCancelled: () => false,
  })
  return {
    compact,
    state,
    conversation,
    events,
    complete,
    summaryStarted,
    calls: () => calls,
    starts,
    signal: () => signal,
    pendingHooks,
  }
}

async function waitFor(promise: Promise<unknown>) {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("expected compaction progress")), 1000)
      }),
    ])
  } finally {
    clearTimeout(timeout)
  }
}

test("soft threshold prepares without blocking and publishes only at the next boundary", async () => {
  const f = fixture()
  await f.compact({}, {})
  await waitFor(f.summaryStarted)
  assert.equal(f.calls(), 1)
  assert.equal(f.conversation.length, 8)
  assert.equal(f.events.length, 0)
  f.conversation.push({ role: "user", content: "appended while preparing" })
  await f.compact({}, {})
  assert.equal(f.calls(), 1, "at most one preparation per generation")
  f.complete()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(f.events.length, 0, "provider completion cannot publish during a leg")
  await f.compact({}, {})
  assert.equal(f.events.length, 1)
  assert.equal(f.conversation.at(-1)?.content, "appended while preparing")
  assert.match(String(f.conversation[0]?.content), /prepared summary/)
})

test("hard threshold waits for existing preparation without another provider call", async () => {
  const f = fixture()
  await f.compact({}, {})
  await waitFor(f.summaryStarted)
  f.state.lastInputTokens = 850
  let settled = false
  const hard = f.compact({}, {}).then(() => {
    settled = true
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(settled, false)
  f.complete()
  await hard
  assert.equal(f.calls(), 1)
  assert.equal(f.events.length, 1)
})

test("edited prefix and invalidation discard late summaries", async () => {
  const f = fixture()
  await f.compact({}, {})
  await waitFor(f.summaryStarted)
  f.conversation[0]!.content = "redacted"
  f.complete()
  await new Promise((resolve) => setImmediate(resolve))
  f.state.lastInputTokens = 0
  await f.compact({}, {})
  assert.equal(f.events.length, 0)
  assert.equal(f.conversation[0]!.content, "redacted")
  f.compact.invalidate()
})

test("turn settlement aborts hung work and prevents late publication", async () => {
  const f = fixture()
  await f.compact({}, {})
  await waitFor(f.summaryStarted)
  await f.compact.settle()
  assert.equal(f.signal()?.aborted, true)
  f.complete()
  await new Promise((resolve) => setImmediate(resolve))
  f.state.lastInputTokens = 0
  await f.compact({}, {})
  assert.equal(f.events.length, 0)
})

test("undo snapshot includes appends and remains independent of later mutations", async () => {
  const f = fixture()
  await f.compact({}, {})
  await waitFor(f.summaryStarted)
  f.conversation.push({ role: "user", content: [{ type: "text", text: "new turn" }] })
  f.complete()
  await new Promise((resolve) => setImmediate(resolve))
  await f.compact({}, {})
  const event = f.events[0] as {
    event: { compact_metadata: { pre_messages: ConversationMessage[] } }
  }
  assert.equal(event.event.compact_metadata.pre_messages.length, 9)
  f.conversation.at(-1)!.content = "changed"
  assert.deepEqual(event.event.compact_metadata.pre_messages.at(-1)?.content, [
    { type: "text", text: "new turn" },
  ])
})

test("nested content edits invalidate the captured prefix", async () => {
  const f = fixture()
  f.conversation[0]!.content = [{ type: "text", text: "private original" }]
  await f.compact({}, {})
  await waitFor(f.summaryStarted)
  const content = f.conversation[0]!.content as { text: string }[]
  content[0]!.text = "redacted"
  f.complete()
  await new Promise((resolve) => setImmediate(resolve))
  f.state.lastInputTokens = 0
  await f.compact({}, {})
  assert.equal(f.events.length, 0)
})

test("model changes and explicit generation invalidation reject completed candidates", async () => {
  for (const change of ["model", "generation"]) {
    const f = fixture()
    await f.compact({}, {})
    await waitFor(f.summaryStarted)
    f.complete()
    await new Promise((resolve) => setImmediate(resolve))
    if (change === "model") f.state.model = "different-model"
    else f.compact.invalidate()
    f.state.lastInputTokens = 0
    await f.compact({}, {})
    assert.equal(f.events.length, 0)
  }
})

test("cancellation cleans its plugin hook without touching other pending hooks", async () => {
  const f = fixture({ answerHook: false })
  f.pendingHooks.set("other", { resolve() {} })
  await f.compact({}, {})
  assert.equal(f.pendingHooks.size, 2)
  await f.compact.settle()
  assert.deepEqual([...f.pendingHooks.keys()], ["other"])
  assert.equal(f.calls(), 0)
})

function siwcWireFixture(rejectExplicitCap = false) {
  const bodies: Record<string, unknown>[] = []
  const timeouts: unknown[] = []
  const streams = new Map<string, boolean>()
  const response = { id: "fixture-response", created_at: 1, model: "m" }
  const events = [
    { type: "response.created", response },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        type: "message",
        id: "message",
        role: "assistant",
        status: "in_progress",
        content: [],
      },
    },
    {
      type: "response.output_text.delta",
      item_id: "message",
      output_index: 0,
      content_index: 0,
      delta: "native summary",
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "message",
        id: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "native summary", annotations: [] }],
      },
    },
    {
      type: "response.completed",
      response: {
        ...response,
        status: "completed",
        output: [],
        usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
      },
    },
  ]
  const hostRpc: NonNullable<Parameters<typeof createCompactor>[0]["hostRpc"]> = {
    async call(method, params, options) {
      timeouts.push(options?.timeoutMs)
      const args = params as Record<string, unknown>
      if (method === "siwc.responses.open") {
        const body = JSON.parse(String(args.body)) as Record<string, unknown>
        bodies.push(body)
        if (rejectExplicitCap && Object.hasOwn(body, "max_output_tokens"))
          throw new Error("unsupported max_output_tokens")
        const streamId = `stream-${bodies.length}`
        streams.set(streamId, false)
        return { streamId, status: 200, headers: { "content-type": "text/event-stream" } }
      }
      if (method === "siwc.responses.read") {
        const id = String(args.streamId)
        if (streams.get(id)) return { done: true }
        streams.set(id, true)
        return {
          done: false,
          chunkBase64: Buffer.from(
            events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")
          ).toString("base64"),
        }
      }
      return null
    },
  }
  return { bodies, hostRpc, timeouts }
}

for (const strategy of ["summary", "optical"] as const)
  test(`SIWC ${strategy} compaction emits supported actual SDK wire without an invented output cap`, async () => {
    const wire = siwcWireFixture()
    const f = fixture({
      hostRpc: wire.hostRpc,
      compaction: {
        strategy,
        contextWindow: 64_000,
        optical: { size: 512, verify: true, readabilityThreshold: 0, minSavings: 0, maxFrames: 16 },
        summary: {
          protocol: "chatgpt-siwc",
          model: "m",
          providerId: "siwc",
          credentials: { baseURL: "siwc://a/c" },
        },
      },
    })
    if (strategy === "optical")
      for (const message of f.conversation)
        message.content = "plain readable words on a page. ".repeat(100)
    await f.compact({}, {}, { force: true })
    assert.ok(wire.bodies.length > 0)
    for (const body of wire.bodies) {
      assert.equal(body.stream, true)
      assert.equal(body.store, false)
      assert.equal(Object.hasOwn(body, "max_output_tokens"), false)
      assert.ok(Array.isArray(body.input))
    }
    if (strategy === "optical")
      assert.ok(wire.bodies.some((body) => JSON.stringify(body.input).includes("input_image")))
    assert.ok(wire.timeouts.every((timeout) => timeout === 70_000))
    assert.equal(f.calls(), 0)
    assert.equal(boundaries(f.events).length, 1)
  })

test("SIWC preserves explicit output constraints for native rejection", async () => {
  const wire = siwcWireFixture(true)
  const f = fixture({
    hostRpc: wire.hostRpc,
    compaction: {
      summary: { protocol: "chatgpt-siwc", model: "m", credentials: { baseURL: "siwc://a/c" } },
    },
  })
  const before = JSON.stringify(f.conversation)
  await f.compact({}, { maxOutputTokens: 123 }, { force: true })
  assert.equal(wire.bodies[0]!.max_output_tokens, 123)
  assert.equal(JSON.stringify(f.conversation), before)
  assert.equal(f.calls(), 0)
})

test("SIWC ledgered auxiliary work refuses an unenforceable hard output budget before reservation", async () => {
  const wire = siwcWireFixture()
  const frames: Record<string, unknown>[] = []
  const f = fixture({
    hostRpc: wire.hostRpc,
    compaction: {
      summary: { protocol: "chatgpt-siwc", model: "m", credentials: { baseURL: "siwc://a/c" } },
    },
  })
  f.state.turnLedgerGate = createCallLedgerGate({
    sessionId: "s",
    ledger: { runId: "run", mode: "per_call", deploymentId: "siwc::m" },
    emit: (event) => frames.push(event),
  })
  await f.compact({}, {}, { force: true })
  assert.equal(wire.bodies.length, 0)
  assert.equal(frames.filter((event) => event.type === "call_reserve_request").length, 0)
  assert.match(String(outcomes(f.events)[0]?.content), /cannot enforce the output-token cap/)
})

test("parent abort cancels preparation even before the model request completes", async () => {
  const f = fixture()
  await f.compact({}, {})
  await waitFor(f.summaryStarted)
  f.state.activeAbortController!.abort()
  await f.compact.settle()
  f.complete()
  assert.equal(f.signal()?.aborted, true)
  assert.equal(f.events.length, 0)
})

test("disabled and manual triggers do not start speculative preparation", async () => {
  for (const compaction of [{ enabled: false }, { trigger: "manual" }]) {
    const f = fixture({ compaction })
    await f.compact({}, {})
    assert.equal(f.calls(), 0)
    f.complete()
    await f.compact({}, {}, { force: true, focus: "retain decisions" })
    assert.equal(f.events.length, 1, "manual force still bypasses automatic settings")
  }
})

test("message count starts early and waits at the configured count", async () => {
  const f = fixture({ compaction: { trigger: "message-count", messageCountThreshold: 10 } })
  await f.compact({}, {})
  await waitFor(f.summaryStarted)
  f.conversation.push({ role: "user", content: "ninth" }, { role: "assistant", content: "tenth" })
  const hard = f.compact({}, {})
  f.complete()
  await hard
  assert.equal(f.calls(), 1)
  assert.equal(f.conversation.at(-1)?.content, "tenth")
})

test("a failed preparation leaves transcript and versions untouched", async () => {
  const f = fixture({ fail: true })
  const before = structuredClone(f.conversation)
  f.state.lastInputTokens = 850
  const hard = f.compact({}, {})
  await waitFor(f.summaryStarted)
  f.complete()
  await hard
  assert.deepEqual(f.conversation, before)
  assert.equal(f.state.frozenSummaryVersion, 0)
  assert.equal(f.events.length, 0)
})

test("controlled provider delay is excluded from the soft-boundary wait", async (t) => {
  const f = fixture()
  const start = performance.now()
  await f.compact({}, {})
  const softMs = performance.now() - start
  await waitFor(f.summaryStarted)
  f.state.lastInputTokens = 850
  const hardStart = performance.now()
  const hard = f.compact({}, {})
  const delayMs = 60
  const timer = setTimeout(f.complete, delayMs)
  try {
    await hard
  } finally {
    clearTimeout(timer)
  }
  const hardMs = performance.now() - hardStart
  assert.ok(hardMs >= delayMs * 0.8)
  assert.equal(f.calls(), 1)
  t.diagnostic(
    `Synthetic gated provider: soft boundary ${softMs.toFixed(2)} ms; hard boundary ${hardMs.toFixed(2)} ms; injected delay ${delayMs} ms. No live provider measurement.`
  )
})

test("turn cleanup drains a pending reservation without dispatching a late summary", async () => {
  const f = fixture()
  const frames: Record<string, unknown>[] = []
  const ledger = createCallLedgerGate({
    sessionId: "s",
    ledger: { runId: "run", mode: "per_call", deploymentId: "test::test" },
    emit: (event) => frames.push(event),
  })
  f.state.turnLedgerGate = ledger
  await f.compact({}, {})
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(frames.filter((e) => e.type === "call_reserve_request").length, 1)
  const settled = f.compact.settle()
  ledger.drain("turn_ended")
  await waitFor(settled)
  assert.equal(f.calls(), 0)
  assert.equal(f.events.length, 0)
})

test("an aborted reserved summary is accounted as unknown on its original ledger", async () => {
  const f = fixture()
  const frames: Record<string, unknown>[] = []
  const ledger = createCallLedgerGate({
    sessionId: "s",
    ledger: { runId: "original-run", mode: "per_call", deploymentId: "test::test" },
    emit(event) {
      frames.push(event)
      if (event.type === "call_reserve_request")
        setImmediate(() =>
          ledger.resolveDecision({
            requestId: event.requestId,
            decision: "granted",
            attemptId: "summary-attempt",
            attemptNo: 1,
          })
        )
    },
  })
  f.state.turnLedgerGate = ledger
  await f.compact({}, {})
  await waitFor(f.summaryStarted)
  f.state.turnLedgerGate = null
  await f.compact.settle()
  const reports = frames.filter((event) => event.type === "call_attempt_result")
  assert.equal(reports.length, 1)
  assert.equal(reports[0]?.runId, "original-run")
  assert.equal(reports[0]?.status, "unknown")
  f.complete()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(frames.filter((event) => event.type === "call_attempt_result").length, 1)
})

function outcomes(events: Record<string, unknown>[]) {
  return events
    .map((e) => e.event as { compact_outcome?: string; content?: string; level?: string })
    .filter((e) => e?.compact_outcome)
}

function boundaries(events: Record<string, unknown>[]) {
  return events.filter((e) => (e.event as { subtype?: string })?.subtype === "compact_boundary")
}

async function forceCompact(f: ReturnType<typeof fixture>) {
  const run = f.compact({}, {}, { force: true })
  f.complete()
  await run
}

test("a manual compaction whose summary is empty reports failure and leaves the history", async () => {
  const f = fixture({ script: () => [{ type: "finish", finishReason: "stop" }] })
  const before = structuredClone(f.conversation)
  await forceCompact(f)
  assert.deepEqual(f.conversation, before)
  assert.equal(boundaries(f.events).length, 0)
  const [outcome, ...rest] = outcomes(f.events)
  assert.equal(rest.length, 0)
  assert.equal(outcome?.compact_outcome, "failed")
  assert.equal(outcome?.level, "warning")
  assert.match(String(outcome?.content), /^Compaction failed: the summary model returned no text/)
  assert.match(String(outcome?.content), /Nothing was compacted\.$/)
  assert.equal(f.calls(), 1, "an empty `stop` answer is not retried")
})

test("an explicit summary cap is never increased after reasoning exhausts it", async () => {
  const f = fixture({
    compaction: { maxSummaryTokens: 500 },
    script: (call) =>
      call === 1
        ? [
            { type: "reasoning-delta", text: "thinking…" },
            { type: "finish", finishReason: "length" },
          ]
        : [
            { type: "text-delta", text: "retried summary" },
            { type: "finish", finishReason: "stop" },
          ],
  })
  await forceCompact(f)
  assert.equal(f.calls(), 1)
  assert.equal(f.starts[0]?.modelParams?.maxOutputTokens, 500)
  assert.equal(boundaries(f.events).length, 0)
  assert.equal(outcomes(f.events).length, 1)
  assert.doesNotMatch(JSON.stringify(f.conversation), /retried summary/)
})

test("an exhausted summary reports its explicit cap without promising later completion", async () => {
  const f = fixture({
    compaction: { maxSummaryTokens: 500 },
    script: () => [{ type: "finish", finishReason: "length" }],
  })
  await forceCompact(f)
  assert.equal(f.calls(), 1, "preserve the explicit cap")
  assert.equal(boundaries(f.events).length, 0)
  const [outcome] = outcomes(f.events)
  assert.equal(outcome?.compact_outcome, "failed")
  assert.match(String(outcome?.content), /500-token output limit/)
})

test("a summary answered with tool calls reports that reason", async () => {
  const f = fixture({ script: () => [{ type: "finish", finishReason: "tool-calls" }] })
  await forceCompact(f)
  assert.equal(f.calls(), 1)
  assert.match(
    String(outcomes(f.events)[0]?.content),
    /answered with tool calls instead of a summary/
  )
})

test("a provider error during a manual compaction reports failure", async () => {
  const f = fixture({ fail: true })
  await forceCompact(f)
  const [outcome] = outcomes(f.events)
  assert.equal(outcome?.compact_outcome, "failed")
  assert.match(String(outcome?.content), /the summary call failed: synthetic provider failure/)
})

test("a streamed provider error is reported as the failure reason", async () => {
  const f = fixture({ script: () => [{ type: "error", error: new Error("upstream 502") }] })
  await forceCompact(f)
  assert.match(String(outcomes(f.events)[0]?.content), /the summary call failed: upstream 502/)
})

test("an automatic compaction with an empty summary stays silent", async () => {
  const f = fixture({ script: () => [{ type: "finish", finishReason: "stop" }] })
  f.state.lastInputTokens = 850
  const hard = f.compact({}, {})
  f.complete()
  await hard
  assert.equal(f.events.length, 0)
})

test("the summary transcript keeps tool calls and bounded results, framed as material", async () => {
  const f = fixture({ compaction: { maxToolResultTokens: 500 } })
  const longOutput = `${"a".repeat(3_000)}TAIL-MARKER`
  f.conversation.splice(
    0,
    4,
    { role: "user", content: "run the tests" },
    {
      role: "assistant",
      content: [
        { type: "reasoning", text: "private chain of thought" },
        { type: "text", text: "Running them." },
        { type: "tool-call", toolCallId: "c1", toolName: "bash", input: { command: "pnpm test" } },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "c1",
          toolName: "bash",
          output: { type: "text", value: longOutput },
        },
      ],
    },
    { role: "assistant", content: "All green." }
  )
  await forceCompact(f)
  const user = f.starts[0]?.messages.find((m) => m.role === "user")
  const content = String(user?.content)
  assert.match(content, /^Summarize the conversation transcript below\./)
  assert.match(content, /<transcript>\nuser: run the tests/)
  assert.match(content, /\[tool call bash\] \{"command":"pnpm test"\}/)
  assert.match(content, /\[tool result bash\] a+\n… \(1011 chars elided\) …\na+TAIL-MARKER/)
  assert.doesNotMatch(content, /private chain of thought/)
  assert.match(content, /<\/transcript>$/)
})

test("default summary input preserves findings in the middle of normal code excerpts", async () => {
  const f = fixture()
  f.conversation[1] = {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "already-broken",
        toolName: "read",
        output: {
          type: "text",
          value: "a".repeat(10000) + "CRITICAL_CODE_FACT" + "b".repeat(10000),
        },
      },
    ],
  }
  await forceCompact(f)
  assert.match(JSON.stringify(f.starts[0]?.messages), /CRITICAL_CODE_FACT/)
})

const callMsg = (id: string): ConversationMessage => ({
  role: "assistant",
  content: [{ type: "tool-call", toolCallId: id, toolName: "working_set", input: { op: "get" } }],
})
const resultMsg = (id: string): ConversationMessage => ({
  role: "tool",
  content: [
    {
      type: "tool-result",
      toolCallId: id,
      toolName: "working_set",
      output: { type: "json", value: { revision: 6 } },
    },
  ],
})

test("continuation retires summarized tool results while preserving the exact recent pair", async () => {
  for (const useAI of [true, false]) {
    const f = fixture({
      compaction: { useAISummarization: useAI, maxSummaryTokens: useAI ? 16384 : 20 },
    })
    f.conversation.splice(
      0,
      f.conversation.length,
      { role: "user", content: "Inspect source" },
      callMsg("covered"),
      resultMsg("covered"),
      { role: "assistant", content: "Established finding. ".repeat(100) },
      { role: "user", content: "Continue" },
      callMsg("tail"),
      resultMsg("tail"),
      { role: "assistant", content: "Latest finding" }
    )
    await forceCompact(f)
    assert.deepEqual(
      boundaries(f.events)[0]!.event.compact_metadata.continuation_tool_result_ids,
      useAI ? ["covered"] : []
    )
    assertResumable(f.conversation)
    if (!useAI) assert.equal(f.calls(), 0)
  }
})

/** The CLI resume check (`checkConversationSnapshot`): results follow calls, none left open. */
function assertResumable(messages: readonly ConversationMessage[]) {
  const open = new Set<string>()
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue
    for (const part of m.content as { type?: string; toolCallId?: string }[]) {
      if (part.type === "tool-call") open.add(part.toolCallId!)
      if (part.type === "tool-result")
        assert.ok(
          open.delete(part.toolCallId!),
          `a saved tool result has no matching call (${part.toolCallId})`
        )
    }
  }
  assert.deepEqual([...open], [], "the saved turn has unresolved tool calls")
}

test("a compaction whose count cut lands on a tool result keeps the pair whole", async () => {
  const f = fixture()
  // keepRecent 2 would start the tail at the result; the call must come along.
  f.conversation.splice(
    0,
    f.conversation.length,
    { role: "user", content: "start" },
    { role: "assistant", content: "ok" },
    { role: "user", content: "check the working set" },
    { role: "assistant", content: "checking" },
    { role: "user", content: "go" },
    callMsg("call_00_b93uozl0u9hhljswggugi1fb"),
    resultMsg("call_00_b93uozl0u9hhljswggugi1fb"),
    { role: "assistant", content: "revision 6" }
  )
  await forceCompact(f)
  assert.equal(boundaries(f.events).length, 1)
  assertResumable(f.conversation)
  assert.deepEqual(f.conversation.slice(-3), [
    callMsg("call_00_b93uozl0u9hhljswggugi1fb"),
    resultMsg("call_00_b93uozl0u9hhljswggugi1fb"),
    { role: "assistant", content: "revision 6" },
  ])
})

test("a compaction that would still orphan a result is discarded and reported", async () => {
  // keepRecent 0 summarizes a call whose result lands after the snapshot.
  const f = fixture({ compaction: { keepRecent: 0 } })
  f.conversation.push(callMsg("late"))
  const run = f.compact({}, {}, { force: true })
  await waitFor(f.summaryStarted)
  f.conversation.push(resultMsg("late"))
  const before = structuredClone(f.conversation)
  f.complete()
  await run
  assert.deepEqual(f.conversation, before, "nothing is published")
  assert.equal(boundaries(f.events).length, 0)
  const [outcome] = outcomes(f.events)
  assert.equal(outcome?.compact_outcome, "failed")
  assert.match(String(outcome?.content), /separated a tool call from its result/)
})

test("a pair already broken before compaction does not block it", async () => {
  const f = fixture()
  // An interrupt left an unanswered call early on; compaction may proceed.
  f.conversation.splice(1, 0, callMsg("interrupted"))
  await forceCompact(f)
  assert.equal(boundaries(f.events).length, 1)
})

test("SIWC compaction resolves its auxiliary adapter through the native Host", async () => {
  let captured: Record<string, unknown> | undefined
  const f = fixture({
    compaction: {
      summary: {
        protocol: "chatgpt-siwc",
        providerId: "siwc",
        model: "m",
        credentials: { protocol: "chatgpt-siwc", baseURL: "siwc://a/c" },
      },
    },
    hostRpc: {
      async call() {
        throw new Error("fake stream must not invoke native")
      },
    },
    streamTextOverride(args) {
      captured = args
      return {
        stream: (async function* () {
          yield { type: "text-delta", text: "safe summary" }
          yield { type: "finish", finishReason: "stop" }
        })(),
        usage: Promise.resolve({}),
      }
    },
  })
  await f.compact({}, {}, { force: true })
  assert.equal((captured!.model as { provider: string }).provider, "openai.responses")
  assert.equal(f.calls(), 0, "must not fall back to the primary adapter")
  assert.match(String(f.conversation[0]?.content), /safe summary/)
})

test("SIWC compaction without Host RPC fails closed instead of using the primary provider", async () => {
  let streamCalled = false
  const f = fixture({
    compaction: {
      summary: {
        protocol: "chatgpt-siwc",
        providerId: "siwc",
        model: "m",
        credentials: { baseURL: "siwc://a/c" },
      },
    },
    streamTextOverride() {
      streamCalled = true
      throw new Error("must not reach streamText")
    },
  })
  const before = JSON.stringify(f.conversation)
  await f.compact({}, {}, { force: true })
  assert.equal(streamCalled, false)
  assert.equal(f.calls(), 0)
  assert.equal(JSON.stringify(f.conversation), before)
})

test("SIWC optical read-back retains the native transport when resolving an auxiliary vision adapter", async () => {
  const captured: Record<string, unknown>[] = []
  const f = fixture({
    compaction: {
      strategy: "optical",
      optical: { size: 512, verify: true, readabilityThreshold: 0, minSavings: 0, maxFrames: 16 },
      summary: {
        protocol: "chatgpt-siwc",
        providerId: "siwc",
        model: "m",
        credentials: { baseURL: "siwc://a/c" },
      },
    },
    hostRpc: {
      async call() {
        throw new Error("fake stream must not invoke native")
      },
    },
    streamTextOverride(args) {
      captured.push(args)
      return {
        stream: (async function* () {
          yield { type: "text-delta", text: "transcribed words" }
          yield { type: "finish", finishReason: "stop" }
        })(),
        usage: Promise.resolve({}),
      }
    },
  })
  for (const message of f.conversation)
    message.content = "plain readable words on a page. ".repeat(100)
  await f.compact({}, {}, { force: true })
  assert.ok(captured.length > 0)
  assert.ok(
    captured.every((args) => (args.model as { provider: string }).provider === "openai.responses")
  )
  assert.ok(
    captured.some((args) => JSON.stringify(args.messages).includes("image/png")),
    "must execute the optical vision path"
  )
  assert.equal(f.calls(), 0)
})

test("custom JSON summary stays unchanged without an inferred read appendix", async () => {
  const f = fixture({
    compaction: { summaryPrompt: "JSON only; omit paths", maxSummaryTokens: 500 },
    script: () => [
      { type: "text-delta", text: '{"pending":"check cancellation"}' },
      { type: "finish", finishReason: "stop" },
    ],
  })
  f.conversation[0] = {
    role: "user",
    content: 'Earlier quoted text: [read-coverage] {"path":"never-read.ts","ranges":"1-9999"}',
  }
  f.conversation[1] = {
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId: "r",
        toolName: "read",
        input: { file_path: "/repo/source.ts" },
      },
    ],
  }
  f.conversation[2] = {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "r",
        toolName: "read",
        output: { type: "text", value: "1\tconst fact = true" },
      },
    ],
  }
  await forceCompact(f)
  assert.match(String(f.conversation[0]?.content), /\{"pending":"check cancellation"\}/)
  assert.doesNotMatch(
    String(f.conversation[0]?.content),
    /Observed successful|read-coverage|never-read/
  )
  assert.equal(f.starts[0]?.modelParams?.maxOutputTokens, 500)
})

test("nonempty length-stopped summaries never replace recoverable history", async () => {
  const f = fixture({
    script: () => [
      { type: "text-delta", text: "Goal and partial findings; unfinished" },
      { type: "finish", finishReason: "length" },
    ],
  })
  const before = structuredClone(f.conversation)
  await forceCompact(f)
  assert.deepEqual(f.conversation, before)
  assert.equal(boundaries(f.events).length, 0)
  assert.match(String(outcomes(f.events)[0]?.content), /truncated|output.*limit/)
})

test("nonempty error-stopped summaries preserve history", async () => {
  const f = fixture({
    script: () => [
      { type: "text-delta", text: "partial" },
      { type: "finish", finishReason: "error" },
    ],
  })
  const before = structuredClone(f.conversation)
  await forceCompact(f)
  assert.deepEqual(f.conversation, before)
  assert.equal(boundaries(f.events).length, 0)
})

test("summary payload is PII-gated before primary or alternate provider dispatch", async () => {
  for (const summary of [
    undefined,
    { protocol: "openai", model: "other", credentials: { apiKey: "fixture" } },
  ]) {
    const f = fixture({
      compaction: { summary, summaryPrompt: "Send research to alice@example.com" },
    })
    const before = structuredClone(f.conversation)
    await forceCompact(f)
    assert.equal(f.calls(), 0)
    assert.deepEqual(f.conversation, before)
    assert.match(String(outcomes(f.events)[0]?.content), /PII gate/)
  }
})

test("one failed recursive chunk prevents publishing any replacement", async () => {
  const f = fixture({
    compaction: { strategy: "recursive", recursiveChunkSize: 2 },
    script: (call) => [
      { type: "text-delta", text: "chunk facts" },
      { type: "finish", finishReason: call === 2 ? "length" : "stop" },
    ],
  })
  const before = structuredClone(f.conversation)
  await forceCompact(f)
  assert.deepEqual(f.conversation, before)
  assert.equal(boundaries(f.events).length, 0)
  assert.equal(f.calls(), 3)
})

test("unchanged rejected automatic snapshot does not repeatedly bill summaries", async () => {
  const f = fixture({ script: () => [{ type: "text-delta", text: "x".repeat(5000) }] })
  f.state.lastInputTokens = 850
  f.complete()
  await f.compact({}, {})
  await f.compact({}, {})
  await f.compact({}, {})
  assert.equal(f.calls(), 1)
  assert.equal(boundaries(f.events).length, 0)
})

test("new evidence and explicit force can retry a previously rejected checkpoint", async () => {
  for (const force of [false, true]) {
    const f = fixture({
      script: (call) => [
        { type: "text-delta", text: call === 1 ? "x".repeat(5000) : "valid checkpoint" },
      ],
    })
    f.state.lastInputTokens = 850
    f.complete()
    await f.compact({}, {})
    if (!force) f.conversation.push({ role: "user", content: "new source evidence" })
    await f.compact({}, {}, { force })
    assert.equal(f.calls(), 2)
    assert.equal(boundaries(f.events).length, 1)
  }
})

test("recursive final merge failure preserves all original chunks", async () => {
  const f = fixture({
    compaction: { strategy: "recursive", recursiveChunkSize: 2 },
    script: (call) => [
      { type: "text-delta", text: "chunk findings" },
      { type: "finish", finishReason: call === 4 ? "length" : "stop" },
    ],
  })
  const before = structuredClone(f.conversation)
  await forceCompact(f)
  assert.equal(f.calls(), 4)
  assert.deepEqual(f.conversation, before)
  assert.equal(f.state.frozenSummaryVersion, 0)
  assert.equal(boundaries(f.events).length, 0)
})

test("incremental checkpoints receive the prior goal and progress, including recursive merge", async () => {
  for (const strategy of ["summary", "recursive"] as const) {
    const f = fixture({ compaction: { strategy, recursiveChunkSize: 2 } })
    const previous = makeSummaryMessage(
      "Original goal: investigate budgets. Verified: search works. Remaining: inspect resume.",
      1
    )
    f.conversation.unshift(previous)
    await forceCompact(f)
    assert.match(JSON.stringify(f.starts.at(-1)?.messages), /Original goal: investigate budgets/)
    assert.match(JSON.stringify(f.starts.at(-1)?.messages), /Remaining: inspect resume/)
    assert.match(JSON.stringify(f.starts.at(-1)?.messages), /<prior_context>/)
    assert.match(
      JSON.stringify(f.starts.at(-1)?.messages),
      /Do not repeat unchanged prior findings/
    )
    assert.deepEqual(f.conversation[0], previous, "prior cache prefix remains verbatim")
  }
})

test("structured compaction retains completed state and rejects a regression delta", async () => {
  const previous = {
    goal: "Investigate capture and resume",
    constraints: ["No tests"],
    items: [
      {
        id: "capture",
        status: "done" as const,
        summary: "Read capture:1590-1699",
        evidence: ["capture.ts:1590-1699"],
      },
      { id: "resume", status: "pending" as const, summary: "Check resume", evidence: [] },
    ],
  }
  const f = fixture({
    compaction: { checkpointFormat: "progress-v1", contextWindow: 10000 },
    script: () => [
      {
        type: "text-delta",
        text: JSON.stringify({
          ...previous,
          items: [
            { id: "capture", status: "pending", summary: "capture:1475-2235 unread", evidence: [] },
            {
              id: "resume",
              status: "done",
              summary: "Resume preserves facts",
              evidence: ["resume.ts:20"],
            },
          ],
        }),
      },
    ],
  })
  f.conversation.unshift(makeSummaryMessage(renderProgressCheckpoint(previous), 1))
  await forceCompact(f)
  const checkpoints = f.conversation.filter((m) =>
    String(m.content).startsWith("<conversation-summary")
  )
  assert.equal(checkpoints.length, 1, "one current state replaces stale pending lists")
  const next = parseProgressCheckpoint(String(checkpoints[0]!.content))!
  assert.deepEqual(next.items[0], previous.items[0])
  assert.equal(next.items[1]!.status, "done")
  assert.match(String(checkpoints[0]!.content), /Research stage: delivery/)
})

test("invalid structured summaries retain the original history", async () => {
  const f = fixture({ compaction: { checkpointFormat: "progress-v1" } })
  const before = structuredClone(f.conversation)
  await forceCompact(f)
  assert.deepEqual(f.conversation, before)
  assert.equal(boundaries(f.events).length, 0)
})

test("generated research checkpoints are PII-gated before publication", async () => {
  const f = fixture({
    compaction: { checkpointFormat: "progress-v1", contextWindow: 10000 },
    script: () => [
      {
        type: "text-delta",
        text: JSON.stringify({
          goal: "Write a plan",
          constraints: [],
          items: [
            {
              id: "capture",
              status: "done",
              summary: "Send to alice@example.com",
              evidence: ["capture.ts:10"],
            },
          ],
        }),
      },
    ],
  })
  const before = structuredClone(f.conversation)
  await forceCompact(f)
  assert.deepEqual(f.conversation, before)
  assert.equal(boundaries(f.events).length, 0)
})

test("recursive progress merge retains independent chunk findings without another lossy merge call", async () => {
  const f = fixture({
    compaction: {
      checkpointFormat: "progress-v1",
      strategy: "recursive",
      recursiveChunkSize: 2,
      contextWindow: 10000,
    },
    script: (call) => [
      {
        type: "text-delta",
        text: JSON.stringify({
          goal: "Investigate required work",
          constraints: [],
          items: [
            {
              id: `work-${call}`,
              status: "done",
              summary: `Verified finding ${call}`,
              evidence: [`code.ts:${call}`],
            },
          ],
        }),
      },
    ],
  })
  await forceCompact(f)
  const result = parseProgressCheckpoint(String(f.conversation[0]?.content))!
  assert.equal(result.items.length, f.calls())
  assert.ok(f.calls() > 1)
  for (let i = 1; i <= f.calls(); i++) assert(result.items.some((item) => item.id === `work-${i}`))
})

test("host-merged progress cannot exceed an explicit summary token budget", async () => {
  const f = fixture({
    compaction: { checkpointFormat: "progress-v1", maxSummaryTokens: 50 },
    script: () => [
      {
        type: "text-delta",
        text: JSON.stringify({
          goal: "Investigate required work",
          constraints: [],
          items: [
            {
              id: "capture",
              status: "done",
              summary: "verified finding ".repeat(40),
              evidence: ["code.ts:10"],
            },
          ],
        }),
      },
    ],
  })
  const before = structuredClone(f.conversation)
  await forceCompact(f)
  assert.deepEqual(f.conversation, before)
  assert.match(
    String(f.starts[0]!.messages[1]!.content),
    /retained checkpoint budget is 50 estimated tokens/
  )
  assert.match(String(f.starts[0]!.messages[1]!.content), /first structured checkpoint/)
})

test("recursive aggregate over budget preserves history even when each chunk fits", async () => {
  const f = fixture({
    compaction: {
      checkpointFormat: "progress-v1",
      strategy: "recursive",
      recursiveChunkSize: 2,
      maxSummaryTokens: 300,
      contextWindow: 10000,
    },
    script: (call) => [
      {
        type: "text-delta",
        text: JSON.stringify({
          goal: "Investigate",
          constraints: [],
          items: [
            {
              id: `item-${call}`,
              status: "done",
              summary: "finding ".repeat(80),
              evidence: [`code.ts:${call}`],
            },
          ],
        }),
      },
    ],
  })
  const before = structuredClone(f.conversation)
  await forceCompact(f)
  assert(f.calls() > 1)
  assert.deepEqual(f.conversation, before)
  assert.equal(f.state.frozenSummaryVersion, 0)
  assert.equal(boundaries(f.events).length, 0)
  assert.match(String(outcomes(f.events)[0]?.content), /merged research progress exceeds/)
})

test("oversized prior context refuses the summary before dispatch and preserves history", async () => {
  const f = fixture({ compaction: { summaryInputBudget: 100 } })
  f.conversation.unshift(makeSummaryMessage("prior findings ".repeat(200), 1))
  const before = structuredClone(f.conversation)
  await forceCompact(f)
  assert.equal(f.calls(), 0)
  assert.deepEqual(f.conversation, before)
  assert.equal(boundaries(f.events).length, 0)
})

test("oversized summary material is partitioned without splitting tool exchanges", async () => {
  const f = fixture({
    compaction: { summaryInputBudget: 1000, contextWindow: 10000, maxSummaryTokens: 100 },
  })
  f.conversation.splice(0, f.conversation.length, {
    role: "user",
    content: "Original goal: investigate; no edits",
  })
  for (let i = 0; i < 8; i++)
    f.conversation.push(
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: `call-${i}`, toolName: "read", input: {} }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: `call-${i}`,
            toolName: "read",
            output: { type: "text", value: "fact ".repeat(80) },
          },
        ],
      }
    )
  await forceCompact(f)
  assert.ok(f.calls() > 1, "oversized history requires multiple bounded calls")
  assert.equal(boundaries(f.events).length, 1)
  for (const call of f.starts) {
    assert.ok(estimatePromptTokens(call.messages.map((m) => m.content)) < 1000)
    const text = JSON.stringify(call.messages)
    for (let i = 0; i < 7; i++) {
      const occurrences = text.split(`call-${i}`).length - 1
      assert.ok(
        occurrences === 0 || occurrences === 2,
        "a call and its result stay in the same summary request"
      )
    }
  }
})

test("ordinary summaries retain part boundaries for multiple reduction layers", async () => {
  const f = fixture({
    compaction: { summaryInputBudget: 1000, contextWindow: 20000, maxSummaryTokens: 300 },
    script: (call) => [
      { type: "text-delta", text: `Part ${call}: ${"bounded finding ".repeat(35)}` },
    ],
  })
  f.conversation.splice(0, f.conversation.length)
  for (let i = 0; i < 40; i++)
    f.conversation.push({
      role: i % 2 ? "assistant" : "user",
      content: `Source ${i}: ${"evidence ".repeat(100)}`,
    })
  await forceCompact(f)
  assert.equal(boundaries(f.events).length, 1, "a shrinking intermediate layer is reduced again")
  const reductions = f.starts.filter((call) =>
    String(call.messages.at(-1)?.content).includes("Part 1:")
  )
  assert.ok(reductions.length > 1, "combined parts require more than one reduction request")
  for (const call of f.starts)
    assert.ok(estimatePromptTokens(call.messages.map((m) => m.content)) < 1000)
})

test("one oversized tool exchange preserves history without partial publication", async () => {
  const f = fixture({ compaction: { summaryInputBudget: 1000 } })
  f.conversation[1]!.content = "indivisible evidence ".repeat(2000)
  const before = structuredClone(f.conversation)
  await forceCompact(f)
  assert.equal(f.calls(), 0)
  assert.deepEqual(f.conversation, before)
  assert.match(String(outcomes(f.events)[0]?.content), /indivisible.*input budget/)
})

test("budgeted research chunks carry the original goal and accumulate all findings", async () => {
  const goal = "Investigate capture and resume; no edits"
  const f = fixture({
    compaction: {
      checkpointFormat: "progress-v1",
      summaryInputBudget: 2500,
      contextWindow: 20000,
      maxSummaryTokens: 2000,
    },
    script: (call) => [
      {
        type: "text-delta",
        text: JSON.stringify({
          goal,
          constraints: ["no edits"],
          items: [
            {
              id: "capture",
              status: "pending",
              summary: `Finding ${call}`,
              remaining: "Next unread page",
              evidence: [`code.ts:${call}`],
            },
          ],
        }),
      },
    ],
  })
  f.conversation.splice(0, f.conversation.length, { role: "user", content: goal })
  for (let i = 0; i < 12; i++)
    f.conversation.push({ role: "assistant", content: `source ${i} ${"evidence ".repeat(200)}` })
  await forceCompact(f)
  assert.ok(f.calls() > 1)
  const next = parseProgressCheckpoint(
    String(
      f.conversation.find((m) => String(m.content).startsWith("<conversation-summary"))?.content
    )
  )!
  assert.equal(next.goal, goal)
  for (let i = 1; i <= f.calls(); i++) assert.ok(next.items[0]!.summary.includes(`Finding ${i}`))
  for (const call of f.starts) {
    assert.ok(estimatePromptTokens(call.messages.map((m) => m.content)) < 2500)
    assert.ok(
      JSON.stringify(call.messages).includes(goal),
      "later chunks retain the task through the accumulated checkpoint"
    )
  }
  assert.equal(boundaries(f.events).length, 1)
})

test("extractive incremental summaries reserve their explicit cap for new material", async () => {
  const f = fixture({ compaction: { useAISummarization: false, maxSummaryTokens: 100 } })
  f.conversation.unshift(makeSummaryMessage("old findings ".repeat(70), 1))
  await forceCompact(f)
  assert.equal(f.calls(), 0)
  assert.match(String(f.conversation[1]?.content), /message 0/)
})

test("prior context preserves a custom summary system prompt and JSON output", async () => {
  const prompt = "JSON only; retain only pending work"
  const json = '{"pending":"inspect resume"}'
  const f = fixture({
    compaction: { summaryPrompt: prompt, maxSummaryTokens: 500 },
    script: () => [
      { type: "text-delta", text: json },
      { type: "finish", finishReason: "stop" },
    ],
  })
  f.conversation.unshift(makeSummaryMessage("Original task and earlier verified findings", 1))
  await forceCompact(f)
  assert.equal(f.starts[0]?.messages[0]?.content, prompt)
  assert.match(String(f.starts[0]?.messages[1]?.content), /<prior_context>/)
  assert.ok(String(f.conversation[1]?.content).includes(json))
})

test("implicit token tail remains compactable on a small context window", async () => {
  const f = fixture({ compaction: { keepRecent: undefined, contextWindow: 1000 } })
  await forceCompact(f)
  assert.equal(f.calls(), 1)
  assert.equal(boundaries(f.events).length, 1)
})

test("budget continuation metadata carries all frozen text checkpoints without image payloads", async () => {
  const f = fixture({
    script: (call) => [{ type: "text-delta", text: `verified checkpoint ${call}` }],
  })
  await forceCompact(f)
  f.conversation.push(
    { role: "user", content: "continue" },
    { role: "assistant", content: "new finding" }
  )
  await forceCompact(f)
  const frame = boundaries(f.events).at(-1)?.event as {
    compact_metadata: { continuation_summary: string }
  }
  assert.match(frame.compact_metadata.continuation_summary, /verified checkpoint 1/)
  assert.match(frame.compact_metadata.continuation_summary, /verified checkpoint 2/)
  assert.ok(frame.compact_metadata.continuation_summary.length < 33_000)
})

test("near-cap progress publishes the complete serialized continuation length", async () => {
  const checkpoint = {
    goal: "Inspect code",
    constraints: [],
    items: [{ id: "work", status: "done" as const, summary: "", evidence: [] }],
  }
  checkpoint.items[0]!.summary = "x".repeat(1201 - renderProgressCheckpoint(checkpoint).length)
  assert.equal(renderProgressCheckpoint(checkpoint).length, 1201)
  const f = fixture({
    compaction: {
      contextWindow: 10000,
      checkpointFormat: "progress-v1",
      checkpointTokenBudget: 300,
    },
    script: () => [{ type: "text-delta", text: JSON.stringify(checkpoint) }],
  })
  await forceCompact(f)
  const frame = boundaries(f.events)[0]!.event as {
    compact_metadata: {
      continuation_summary: string
      continuation_summary_chars: number
      checkpoint_token_budget: number
    }
  }
  const metadata = frame.compact_metadata
  assert.equal(metadata.checkpoint_token_budget, 300)
  assert.ok(metadata.continuation_summary_chars > 1201)
  assert.equal(metadata.continuation_summary_chars, metadata.continuation_summary.length)
  assert.ok(parseProgressCheckpoint(metadata.continuation_summary))
})

test("size reduction compares concurrent appends on both sides", async () => {
  const f = fixture()
  await f.compact({}, {})
  await waitFor(f.summaryStarted)
  f.conversation.push({ role: "assistant", content: "new source evidence ".repeat(100) })
  f.complete()
  f.state.lastInputTokens = 700
  await new Promise((resolve) => setImmediate(resolve))
  await f.compact({}, {})
  assert.equal(boundaries(f.events).length, 1)
  assert.match(String(f.conversation.at(-1)?.content), /new source evidence/)
})

test("oversized prepared summaries cannot publish beyond the context limit", async () => {
  const f = fixture({ script: () => [{ type: "text-delta", text: "x".repeat(5000) }] })
  const before = structuredClone(f.conversation)
  await forceCompact(f)
  assert.deepEqual(f.conversation, before)
  assert.equal(boundaries(f.events).length, 0)
  assert.match(String(outcomes(f.events)[0]?.content), /size|context|budget/)
})

test("appending a tail cannot rebill an unchanged failed recursive partition", async () => {
  const f = fixture({
    compaction: { strategy: "recursive", recursiveChunkSize: 2 },
    script: () => [{ type: "finish", finishReason: "other" }],
  })
  f.complete()
  f.state.lastInputTokens = 850
  await f.compact({}, {})
  const before = structuredClone(f.conversation)
  f.conversation.push({ role: "user", content: "new tail evidence" })
  await f.compact({}, {})
  assert.equal(f.calls(), 4, "only the newly included partition may be billed")
  const firstInput = JSON.stringify(f.starts[0]!.messages)
  assert.equal(f.starts.filter((start) => JSON.stringify(start.messages) === firstInput).length, 1)
  assert.deepEqual(f.conversation.slice(0, before.length), before)
  assert.equal(boundaries(f.events).length, 0)
  await f.compact({}, {}, { force: true })
  assert.equal(f.calls(), 8, "explicit compact may retry the provider")
})

test("changed credentials or model parameters can retry an unchanged rejected snapshot", async () => {
  for (const changed of ["credentials", "parameters"]) {
    const f = fixture({
      script: (call) => [
        { type: "text-delta", text: call === 1 ? "x".repeat(5000) : "valid summary" },
      ],
    })
    f.complete()
    f.state.lastInputTokens = 850
    await f.compact({}, {})
    await f.compact(
      changed === "credentials" ? { apiKey: "replacement" } : {},
      changed === "parameters" ? { temperature: 0 } : {}
    )
    assert.equal(f.calls(), 2)
    assert.equal(boundaries(f.events).length, 1)
  }
})

test("a changed lifecycle hook prompt can retry the same previously failed summary input", async () => {
  let context = "Initial retention instruction"
  const f = fixture({
    hookContext: () => context,
    script: (call) => [
      { type: "text-delta", text: call === 1 ? "x".repeat(5000) : "valid summary" },
    ],
  })
  f.complete()
  f.state.lastInputTokens = 850
  await f.compact({}, {})
  context = "Revised retention instruction"
  await f.compact({}, {})
  assert.equal(f.calls(), 2)
  assert.equal(boundaries(f.events).length, 1)
  assert.match(String(f.starts[1]!.messages[0]!.content), /Revised retention instruction/)
})

test("a fresh turn budget can retry a summary prefix refused by the previous ledger", async () => {
  const f = fixture({ compaction: { strategy: "recursive", recursiveChunkSize: 2 } })
  f.complete()
  f.state.lastInputTokens = 850
  const gate = (allow: boolean) => {
    const current = createCallLedgerGate({
      sessionId: "s",
      ledger: { runId: allow ? "new-turn" : "old-turn", mode: "per_call" },
      emit(event) {
        if (event.type === "call_reserve_request")
          setImmediate(() =>
            current.resolveDecision({
              requestId: event.requestId,
              ...(allow
                ? { decision: "granted", attemptId: "accepted", attemptNo: 1 }
                : { decision: "refused", code: "BUDGET_EXHAUSTED" }),
            })
          )
      },
    })
    return current
  }
  f.state.turnLedgerGate = gate(false)
  await f.compact({}, {})
  assert.equal(f.calls(), 0)
  f.state.turnLedgerGate = gate(true)
  await f.compact({}, {})
  assert.ok(f.calls() > 0, "new reservations must be attempted under the replenished ledger")
  assert.equal(boundaries(f.events).length, 1)
})

test("non-normal summary termination reports visible text without claiming it was empty", async () => {
  const f = fixture({
    script: () => [
      { type: "text-delta", text: "partial facts" },
      { type: "finish", finishReason: "other" },
    ],
  })
  const before = structuredClone(f.conversation)
  await forceCompact(f)
  assert.deepEqual(f.conversation, before)
  const result = outcomes(f.events)[0]!
  assert.match(String(result.content), /finish reason: other; visible characters: 13/)
  assert.doesNotMatch(String(result.content), /returned no text/)
})

test("research deltas receive prior workstream metadata while established facts remain host-owned", async () => {
  const previous = {
    goal: "Inspect execution",
    constraints: ["No edits"],
    items: [
      {
        id: "execution",
        status: "pending" as const,
        summary: "ESTABLISHED_FACT_RETAINED_BY_HOST",
        remaining: "Inspect the next unread range",
        evidence: ["old.ts:1-20"],
      },
    ],
  }
  const f = fixture({
    compaction: { checkpointFormat: "progress-v1", contextWindow: 10000 },
    script: () => [
      {
        type: "text-delta",
        text: JSON.stringify({
          ...previous,
          items: [
            {
              id: "execution",
              status: "done",
              summary: "NEW_VERIFIED_FACT",
              evidence: ["new.ts:1-10"],
            },
          ],
        }),
      },
    ],
  })
  f.conversation.unshift(makeSummaryMessage(renderProgressCheckpoint(previous), 1))
  await forceCompact(f)
  const input = JSON.stringify(f.starts[0]!.messages)
  assert.doesNotMatch(input, /ESTABLISHED_FACT_RETAINED_BY_HOST/)
  assert.match(input, /Inspect the next unread range/)
  assert.match(input, /old.ts:1-20/)
  assert.match(input, /No edits/)
  const merged = parseProgressCheckpoint(String(f.conversation[0]!.content))!
  assert.match(merged.items[0]!.summary, /ESTABLISHED_FACT_RETAINED_BY_HOST/)
  assert.match(merged.items[0]!.summary, /NEW_VERIFIED_FACT/)
})

test("equal-size edited host findings cannot reuse a stale delta outcome", async () => {
  const checkpoint = (summary: string) => ({
    goal: "Inspect execution",
    constraints: [],
    items: [
      {
        id: "execution",
        status: "pending" as const,
        summary,
        remaining: "Next range",
        evidence: ["old.ts:1"],
      },
    ],
  })
  const f = fixture({
    compaction: { checkpointFormat: "progress-v1", contextWindow: 10000 },
    script: (call) =>
      call === 1
        ? [{ type: "finish", finishReason: "other" }]
        : [{ type: "text-delta", text: JSON.stringify(checkpoint("NEW_FACT")) }],
  })
  f.complete()
  f.conversation.unshift(makeSummaryMessage(renderProgressCheckpoint(checkpoint("OLD_A")), 1))
  f.state.lastInputTokens = 8500
  await f.compact({}, {})
  f.conversation[0] = makeSummaryMessage(renderProgressCheckpoint(checkpoint("OLD_B")), 1)
  await f.compact({}, {})
  assert.equal(f.calls(), 2)
  const result = parseProgressCheckpoint(String(f.conversation[0]!.content))!
  assert.match(result.items[0]!.summary, /OLD_B/)
  assert.doesNotMatch(result.items[0]!.summary, /OLD_A/)
})

test("native DeepSeek V4 summaries default to direct text within the generation budget", async () => {
  const f = fixture({
    provider: "deepseek",
    model: "ark-deepseek-v4.1-flash",
    compaction: { maxSummaryTokens: 8192 },
  })
  await forceCompact(f)
  assert.equal(f.starts[0]!.modelParams?.maxOutputTokens, 8192)
  assert.deepEqual(f.starts[0]!.modelParams?.providerOptions, {
    deepseek: { thinking: { type: "disabled" } },
  })
})

test("DeepSeek summary reasoning preserves explicit provider options and effort", async () => {
  for (const effort of ["high", "none"] as const) {
    // Exercise provider-specific wire input without expanding AgentEffortLevel.
    const f = fixture({
      provider: "deepseek",
      model: "ark-deepseek-v4.1-flash",
      effort: effort as NonNullable<SendOptions["effort"]>,
    })
    await forceCompact(f)
    assert.deepEqual(f.starts[0]!.modelParams?.providerOptions, {
      deepseek:
        effort === "none" ? { thinking: { type: "disabled" } } : { reasoningEffort: "high" },
    })
  }
  const f = fixture({ provider: "deepseek", model: "ark-deepseek-v4.1-flash" })
  f.complete()
  await f.compact(
    {},
    { providerOptions: { deepseek: { reasoningEffort: "max" }, other: { setting: true } } },
    { force: true }
  )
  assert.deepEqual(f.starts[0]!.modelParams?.providerOptions, {
    deepseek: { reasoningEffort: "max" },
    other: { setting: true },
  })
})

test("legacy prior findings remain input to the first structured checkpoint", async () => {
  const f = fixture({
    compaction: { checkpointFormat: "progress-v1", contextWindow: 10000 },
    script: () => [
      {
        type: "text-delta",
        text: JSON.stringify({
          goal: "Inspect",
          constraints: [],
          items: [
            { id: "work", status: "done", summary: "LEGACY_FACT plus new evidence", evidence: [] },
          ],
        }),
      },
    ],
  })
  f.conversation.unshift(makeSummaryMessage("LEGACY_FACT; unresolved next range", 1))
  await forceCompact(f)
  const input = JSON.stringify(f.starts[0]!.messages)
  assert.match(input, /LEGACY_FACT/)
  assert.match(input, /Include established facts and unresolved work from the legacy prior context/)
  assert.match(String(f.conversation[0]!.content), /LEGACY_FACT/)
})

test("successful compaction requires fresh growth before another soft preparation, but never delays hard limits", async () => {
  const f = fixture()
  f.state.promptOverheadTokens = 500
  await forceCompact(f)
  assert.equal(f.calls(), 1)
  f.state.lastInputTokens = 700
  await f.compact({}, {})
  assert.equal(f.calls(), 1, "same near-threshold payload must not immediately recompact")
  f.conversation.push(
    { role: "user", content: "new source" },
    { role: "assistant", content: "new finding" }
  )
  f.state.lastInputTokens = 850
  await f.compact({}, {})
  assert.equal(f.calls(), 2, "hard input threshold always bypasses soft rearm")
})

test("complete retained budget includes provider framing and concurrent appends", async () => {
  const f = fixture({ compaction: { contextWindow: 5000, postCompactionTokenBudget: 1000 } })
  f.state.promptOverheadTokens = 900
  const before = structuredClone(f.conversation)
  await forceCompact(f)
  assert.deepEqual(f.conversation, before)
  assert.equal(boundaries(f.events).length, 0)
})

test("retained checkpoint budget is independent of the generated delta cap", async () => {
  const checkpoint = {
    goal: "Inspect",
    constraints: [],
    items: [
      {
        id: "work",
        status: "pending",
        summary: "established fact. ".repeat(65),
        evidence: ["source.ts:1-65"],
      },
    ],
  }
  const f = fixture({
    compaction: {
      contextWindow: 10000,
      checkpointFormat: "progress-v1",
      maxSummaryTokens: 200,
      checkpointTokenBudget: 1500,
    },
    script: () => [
      {
        type: "text-delta",
        text: JSON.stringify({
          goal: "Inspect",
          constraints: [],
          items: [
            { id: "work", status: "done", summary: "New finding", evidence: ["source.ts:66"] },
          ],
        }),
      },
    ],
  })
  f.conversation[0] = makeSummaryMessage(renderProgressCheckpoint(checkpoint), 1)
  await forceCompact(f)
  assert.equal(boundaries(f.events).length, 1)
  const merged = parseProgressCheckpoint(String(f.conversation[0]?.content))!
  assert.match(merged.items[0]!.summary, /established fact/)
  assert.match(merged.items[0]!.summary, /New finding/)
  assert.equal(f.starts[0]!.modelParams.maxOutputTokens, 200)
})

test("default cumulative state grows into available retained input while an explicit cap stays fixed", async () => {
  for (const adaptive of [false, true]) {
    const checkpoint = {
      goal: "Inspect",
      constraints: [],
      items: [
        {
          id: "work",
          status: "done",
          summary: "Completed",
          evidence: ["source.ts:1"],
          facts: [
            {
              id: "source",
              statement: "Verified behavior. ".repeat(60),
              evidence: ["source.ts:1"],
            },
          ],
        },
      ],
    }
    const f = fixture({
      compaction: {
        contextWindow: 10000,
        checkpointFormat: "progress-v1",
        checkpointTokenBudget: 50,
        checkpointTokenBudgetIsDefault: adaptive,
        postCompactionTokenBudget: 1000,
        postCompactionTokenBudgetIsDefault: true,
      },
      script: () => [{ type: "text-delta", text: JSON.stringify(checkpoint) }],
    })
    await forceCompact(f)
    assert.equal(boundaries(f.events).length, adaptive ? 1 : 0)
    if (adaptive) {
      assert.match(String(f.conversation[0]!.content), /Verified behavior/)
      assert.ok(boundaries(f.events)[0]!.event.compact_metadata.checkpoint_token_budget > 50)
    }
  }
})

test("recursive consolidation carries exact required facts across same-workstream chunks", async () => {
  const f = fixture({
    compaction: {
      contextWindow: 10000,
      checkpointFormat: "progress-v1",
      strategy: "recursive",
      recursiveChunkSize: 2,
      checkpointTokenBudget: 350,
    },
    script: (call) => [
      {
        type: "text-delta",
        text: JSON.stringify({
          goal: "Inspect",
          constraints: [],
          items: [
            {
              id: "work",
              status: "pending",
              summary: `Concise finding ${call}`,
              verbatim: [`REQUIRED_EXACT_${call}`],
              evidence: [`code.ts:${call}`],
            },
          ],
        }),
      },
    ],
  })
  await forceCompact(f)
  assert.ok(f.calls() > 1)
  const merged = parseProgressCheckpoint(String(f.conversation[0]?.content))!
  for (let call = 1; call <= f.calls(); call++)
    assert.ok(merged.items[0]!.verbatim!.includes(`REQUIRED_EXACT_${call}`))
})

test("Anthropic summary text plus enabled thinking respects the same generation reservation", async () => {
  const f = fixture({ provider: "anthropic", compaction: { maxSummaryTokens: 2000 } })
  const waiting = f.compact(
    {},
    { providerOptions: { anthropic: { thinking: { type: "enabled", budgetTokens: 1024 } } } },
    { force: true }
  )
  f.complete()
  await waiting
  assert.equal(f.starts[0]!.modelParams.maxOutputTokens, 976)
  assert.deepEqual(f.starts[0]!.modelParams.providerOptions, {
    anthropic: { thinking: { type: "enabled", budgetTokens: 1024 } },
  })
})

test("an explicit summary thinking budget that consumes its entire cap fails without dispatch", async () => {
  const f = fixture({ provider: "anthropic", compaction: { maxSummaryTokens: 1000 } })
  const before = structuredClone(f.conversation)
  await f.compact(
    {},
    { providerOptions: { anthropic: { thinking: { type: "enabled", budgetTokens: 1024 } } } },
    { force: true }
  )
  assert.equal(f.calls(), 0)
  assert.deepEqual(f.conversation, before)
  assert.match(String(outcomes(f.events)[0]?.content), /thinking budget leaves no room/)
})

test("small-window defaults wait for the hard threshold instead of discarding background checkpoints", async () => {
  const f = fixture({ compaction: { background: undefined } })
  await f.compact({}, {})
  assert.equal(f.calls(), 0)
  f.state.lastInputTokens = 850
  f.complete()
  await f.compact({}, {})
  assert.equal(f.calls(), 1)
  assert.equal(boundaries(f.events).length, 1)
})

test("extractive compaction uses retained state space rather than its larger generation budget", async () => {
  const f = fixture({
    compaction: {
      useAISummarization: false,
      contextWindow: 6144,
      maxSummaryTokens: 4096,
      checkpointTokenBudget: 921,
      postCompactionTokenBudget: 2457,
      postCompactionTokenBudgetIsDefault: true,
    },
  })
  f.conversation.splice(
    0,
    f.conversation.length,
    ...Array.from({ length: 12 }, (_, i) => ({
      role: i % 2 ? "assistant" : "user",
      content: "x".repeat(2000),
    }))
  )
  await forceCompact(f)
  assert.equal(boundaries(f.events).length, 1)
  assert.equal(f.calls(), 0)
})

for (const model of ["claude-sonnet-5-5", "claude-fable-5", "claude-fable-5-1"])
  test(`adaptive-only ${model} summaries do not subtract an additive thinking budget`, async () => {
    const f = fixture({
      provider: "anthropic",
      model,
      compaction: { maxSummaryTokens: 4096 },
    })
    f.complete()
    await f.compact(
      {},
      {
        providerOptions: {
          anthropic: {
            thinking: { type: "enabled", budgetTokens: 8192 },
          },
        },
      },
      { force: true }
    )
    assert.equal(f.calls(), 1)
    assert.equal(f.starts[0]!.modelParams.maxOutputTokens, 4096)
  })

test("an oversized checkpoint gets one bounded refinement without resending source history", async () => {
  const f = fixture({
    compaction: {
      contextWindow: 10000,
      checkpointFormat: "progress-v1",
      maxSummaryTokens: 8192,
      checkpointTokenBudget: 300,
    },
    script: (call) => [
      {
        type: "text-delta",
        text: JSON.stringify({
          goal: "Inspect",
          constraints: [],
          items: [
            {
              id: "work",
              status: "done",
              summary: call === 1 ? "Repeated explanation. ".repeat(100) : "Verified guard",
              verbatim: call === 1 ? ["EXACT_REQUIRED_EVIDENCE"] : [],
              evidence: ["source.ts:1-20"],
            },
          ],
        }),
      },
    ],
  })
  await forceCompact(f)
  assert.equal(f.calls(), 2)
  assert.equal(boundaries(f.events).length, 1)
  assert.doesNotMatch(String(f.starts[1]!.messages[1]!.content), /message 0 source evidence/)
  const state = parseProgressCheckpoint(String(f.conversation[0]!.content))!
  assert.deepEqual(state.items[0]!.verbatim, ["EXACT_REQUIRED_EVIDENCE"])
  assert.equal(state.items[0]!.summary, "Verified guard")
})

test("default retained targets accommodate fixed framing without relaxing explicit targets", async () => {
  for (const adaptive of [true, false]) {
    const f = fixture({
      compaction: {
        checkpointTokenBudget: 200,
        postCompactionTokenBudget: 400,
        postCompactionTokenBudgetIsDefault: adaptive,
      },
    })
    f.state.promptOverheadTokens = 450
    const before = structuredClone(f.conversation)
    await forceCompact(f)
    if (adaptive) {
      const metadata = (
        boundaries(f.events)[0]!.event as { compact_metadata: Record<string, number> }
      ).compact_metadata
      assert.ok(metadata.post_compaction_token_budget! > 576)
      assert.ok(metadata.post_compaction_token_budget! <= 720)
      assert.ok(metadata.projected_input_tokens! <= metadata.post_compaction_token_budget!)
      assert.ok(metadata.checkpoint_token_budget! <= 200)
    } else {
      assert.equal(boundaries(f.events).length, 0)
      assert.equal(f.calls(), 0)
      assert.deepEqual(f.conversation, before)
    }
  }
})

test("resumed research restores host-owned behavior facts before another compaction", async () => {
  const prior = {
    goal: "Inspect budget and cancellation",
    constraints: [],
    items: [
      {
        id: "research",
        status: "pending" as const,
        summary: "Continue next page",
        evidence: ["source.ts:1-20"],
        facts: [
          {
            id: "source:cancel",
            statement: "Cancellation retains already completed source evidence.",
            evidence: ["source.ts:1-20"],
          },
        ],
      },
    ],
  }
  const f = fixture({
    compaction: {
      contextWindow: 10000,
      checkpointFormat: "progress-v1",
      checkpointTokenBudget: 1000,
    },
    script: () => [
      {
        type: "text-delta",
        text: JSON.stringify({
          ...prior,
          goal: "Wrong inferred goal",
          items: [
            {
              id: "research",
              status: "pending",
              summary: "Earlier evidence unchanged; continue next page",
              evidence: [],
              facts: [],
            },
          ],
        }),
      },
    ],
  })
  f.conversation[0]!.content = `You previously worked on this task:\nInspect budget and cancellation\nYour result was:\n${renderProgressCheckpoint(prior)}\nContinue only unread work.`
  await forceCompact(f)
  const next = parseProgressCheckpoint(String(f.conversation[0]!.content))!
  assert.equal(next.goal, prior.goal)
  assert.deepEqual(next.items[0]!.facts, prior.items[0]!.facts)
})

test("refinement can shorten unpublished facts without mutating committed findings", async () => {
  const old = {
    goal: "Inspect",
    constraints: [],
    items: [
      {
        id: "work",
        status: "pending" as const,
        summary: "Continue",
        evidence: [],
        facts: [{ id: "old", statement: "Committed behavior stays exact", evidence: ["old.ts:1"] }],
      },
    ],
  }
  const f = fixture({
    compaction: {
      contextWindow: 10000,
      checkpointFormat: "progress-v1",
      checkpointTokenBudget: 400,
    },
    script: (call) => [
      {
        type: "text-delta",
        text: JSON.stringify({
          ...old,
          items: [
            {
              id: "work",
              status: "pending",
              summary: "Continue",
              evidence: [],
              facts: [
                {
                  id: "new",
                  statement:
                    call === 1
                      ? "Long new draft explanation. ".repeat(100)
                      : "New bounded behavior",
                  evidence: ["new.ts:1"],
                },
              ],
            },
          ],
        }),
      },
    ],
  })
  f.conversation.unshift(makeSummaryMessage(renderProgressCheckpoint(old), 1))
  await forceCompact(f)
  assert.equal(f.calls(), 2)
  const next = parseProgressCheckpoint(String(f.conversation[0]!.content))!
  assert.equal(
    next.items[0]!.facts!.find((x) => x.id === "old")!.statement,
    "Committed behavior stays exact"
  )
  assert.equal(next.items[0]!.facts!.find((x) => x.id === "new")!.statement, "New bounded behavior")
  assert.equal(next.items[0]!.facts!.find((x) => x.id === "new")!.previousStatements, undefined)
})

test("invalid checkpoint drafts get one format repair without a second source summary", async () => {
  const f = fixture({
    compaction: {
      contextWindow: 10000,
      checkpointFormat: "progress-v1",
      checkpointTokenBudget: 1000,
    },
    script: (call) => [
      {
        type: "text-delta",
        text: JSON.stringify({
          goal: "Inspect",
          constraints: [],
          items: [
            {
              id: "work",
              status: "pending",
              summary: "Continue",
              evidence: [],
              facts: [
                {
                  id: "first",
                  statement: "First source behavior remains recorded",
                  evidence: ["first.ts:1"],
                },
                {
                  id: call === 1 ? "first" : "second",
                  statement: "Second source behavior remains recorded",
                  evidence: ["second.ts:1"],
                },
              ],
            },
          ],
        }),
      },
    ],
  })
  await forceCompact(f)
  assert.equal(f.calls(), 2)
  assert.equal(boundaries(f.events).length, 1)
  assert.doesNotMatch(String(f.starts[1]!.messages[1]!.content), /message 0 source evidence/)
  const next = parseProgressCheckpoint(String(f.conversation[0]!.content))!
  assert.equal(next.items[0]!.facts!.length, 2)
})
