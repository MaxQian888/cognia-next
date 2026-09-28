import assert from "node:assert/strict"
import { test } from "node:test"
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { makeInputStream } from "../../shared/input-stream.ts"
import { createDoomLoopGuard } from "../../policy/doom-loop.ts"
import { createCallLedgerGate } from "../common/call-ledger-gate.ts"
import { createAnthropicSession } from "./session.ts"

function makeSession() {
  const inputStream = makeInputStream<SDKUserMessage>()
  const events: Record<string, unknown>[] = []
  const emit = (frame: Record<string, unknown>) => {
    events.push(frame)
  }
  const context = createAnthropicSession({
    q: { async *[Symbol.asyncIterator]() {}, interrupt() {} },
    inputStream,
    doomGuard: createDoomLoopGuard(),
    sessionId: "session",
    emit,
    ledgerGate: createCallLedgerGate({ ledger: null, sessionId: "session", emit }),
    pendingApprovals: new Map(),
    pendingPluginToolCalls: new Map(),
    pendingPluginHookCalls: new Map(),
    sendOptions: {},
  })
  return { ...context, inputStream, events }
}

test("only accepted user input earns a result and compaction keeps its focus", async () => {
  const { session, state, inputStream } = makeSession()
  assert.equal(session.pushUserMessage("first", "now"), true)
  session.requestCompact("  preserve decisions  ")
  assert.equal(state.outstandingPrompts, 2)
  session.closeInput()
  assert.equal(session.pushUserMessage("too late"), false)
  assert.equal(state.outstandingPrompts, 2)
  const messages = []
  for await (const message of inputStream.iterable) messages.push(message)
  assert.equal(messages[0]!.priority, "now")
  assert.equal(messages[1]!.message.content, "/compact preserve decisions")
})

test("session drain notifies approvals before settling both pending channels", () => {
  const { session, events } = makeSession()
  const settled: unknown[] = []
  session.pendingApprovals.set("approval", {
    input: {},
    resolve: (answer) => {
      assert.equal(events[0]?.type, "permission_interrupted")
      settled.push(answer)
    },
  })
  session.pendingPluginToolCalls.set("plugin", {
    resolve: (answer) => {
      settled.push(answer)
    },
  })
  session.drainPending("session closed")
  assert.deepEqual(settled, [
    { behavior: "deny", message: "session closed" },
    { error: "session closed" },
  ])
  assert.equal(session.pendingApprovals.size, 0)
  assert.equal(session.pendingPluginToolCalls.size, 0)
  session.closeInput()
})
