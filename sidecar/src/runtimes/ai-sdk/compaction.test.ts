import { test } from "node:test"
import assert from "node:assert/strict"
import { createCompactor, type CompactionState } from "./compaction.ts"
import type { ConversationMessage } from "../../context/compaction.ts"
import type { PendingPluginHooks } from "../../hooks/kernel/types.ts"
import type { SendOptions } from "../../shared/wire/inbound.ts"
import { createCallLedgerGate } from "../common/call-ledger-gate.ts"
import type { ProtocolAdapter } from "../../providers/protocol-adapters/types.ts"

function fixture(
  options: { compaction?: SendOptions["compaction"]; answerHook?: boolean; fail?: boolean } = {}
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
  const adapter: ProtocolAdapter = {
    id: "test",
    async start(args) {
      calls++
      signal = args.abortSignal
      started()
      return {
        fullStream: (async function* () {
          await gate
          if (options.fail) throw new Error("synthetic provider failure")
          yield { type: "text-delta", text: "prepared summary" }
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
