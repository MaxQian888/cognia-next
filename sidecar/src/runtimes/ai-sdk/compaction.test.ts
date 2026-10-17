import { test } from "node:test"
import assert from "node:assert/strict"
import { createCompactor, type CompactionState } from "./compaction.ts"
import type { ConversationMessage } from "../../context/compaction.ts"
import type { PendingPluginHooks } from "../../hooks/kernel/types.ts"
import type { SendOptions } from "../../shared/wire/inbound.ts"
import { createCallLedgerGate } from "../common/call-ledger-gate.ts"
import type { ProtocolAdapter } from "../../providers/protocol-adapters/types.ts"

function fixture(
  options: {
    compaction?: SendOptions["compaction"]
    answerHook?: boolean
    fail?: boolean
    /** Stream parts for the Nth (1-based) summary call; default one text delta. */
    script?: (call: number) => Record<string, unknown>[]
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
    content: `message ${i}`,
  }))
  const state: CompactionState = {
    model: "test",
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
    id: "test",
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
      compaction: {
        contextWindow: 1000,
        fraction: 0.8,
        keepRecent: 2,
        captureUndoSnapshot: true,
        ...options.compaction,
      },
    },
    provider: "test",
    sessionId: "s",
    sdkSessionId: "sdk",
    protocolAdapter: adapter,
    pendingProtocolExecs: new Map(),
    pendingPluginHookCalls: pendingHooks,
    emit(event) {
      if (event.type === "plugin_hook_exec") {
        if (options.answerHook !== false)
          pendingHooks.get(String(event.execId))?.resolve({ result: {} })
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

test("a summary that spends its cap on reasoning is retried once with headroom", async () => {
  const f = fixture({
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
  assert.equal(f.calls(), 2)
  assert.equal(f.starts[0]?.modelParams?.maxOutputTokens, 500)
  assert.equal(f.starts[1]?.modelParams?.maxOutputTokens, 500 + 4_096)
  assert.equal(boundaries(f.events).length, 1)
  assert.equal(outcomes(f.events).length, 0)
  assert.match(String(f.conversation[0]?.content), /retried summary/)
})

test("a summary still empty after the reasoning retry reports the budget, never 'next turn'", async () => {
  const f = fixture({ script: () => [{ type: "finish", finishReason: "length" }] })
  await forceCompact(f)
  assert.equal(f.calls(), 2, "exactly one retry")
  assert.equal(boundaries(f.events).length, 0)
  const [outcome] = outcomes(f.events)
  assert.equal(outcome?.compact_outcome, "failed")
  assert.match(String(outcome?.content), /whole 4596-token output budget without writing a summary/)
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
  const f = fixture()
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
