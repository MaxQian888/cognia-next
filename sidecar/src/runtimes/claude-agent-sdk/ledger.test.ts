import type { Options } from "@anthropic-ai/claude-agent-sdk"
import type { SendOptions } from "../../shared/wire/inbound.ts"
import type { CallRefusal } from "../common/call-ledger-gate.ts"
// Router + Fusion (ADR-0188) envelope mode on the Claude Agent SDK dispatcher.
// A stub `query()` captures the options the SDK would receive.

import assert from "node:assert/strict"
import { test } from "node:test"

import { dispatchAnthropic } from "./index.ts"
import { createCallLedgerGate } from "../common/call-ledger-gate.ts"
import { buildLedgerToolHooks } from "./ledger.ts"

const ENVELOPE = {
  runId: "run-1",
  mode: "envelope",
  transportAttempts: 1,
  deploymentId: "anthropic:claude-sonnet-5",
  envelopeMaxBudgetUsd: 0.5,
}

function run(sendOptions: SendOptions) {
  const captured: Options[] = []
  const interrupts: boolean[] = []
  const events: Record<string, unknown>[] = []
  const session = dispatchAnthropic(
    {
      sessionId: "s1",
      firstPrompt: "hi",
      sendOptions: {
        cwd: process.cwd(),
        model: "claude-sonnet-5",
        fallbackModel: "claude-haiku-4-5",
        maxBudgetUsd: 2,
        ...sendOptions,
      },
      emit: (event) => events.push(event),
      log() {},
    },
    {
      query: ({ prompt, options }) => {
        captured.push(options)
        return {
          async *[Symbol.asyncIterator]() {
            for await (const input of prompt) {
              yield {
                type: "result",
                subtype: "success",
                session_id: input.session_id,
                result: "ok",
              }
              break
            }
          },
          interrupt: async () => {
            interrupts.push(true)
          },
          close() {},
        }
      },
    }
  )
  return { captured, interrupts, events, session }
}

test("[ACC:OFF-04] without a ledger stamp the SDK keeps its fallback model, budget and retries", () => {
  const { captured, session } = run({})
  const options = captured[0]
  assert.equal(options!.fallbackModel, "claude-haiku-4-5")
  assert.equal(options!.maxBudgetUsd, 2)
  assert.equal(options!.env!.CLAUDE_CODE_MAX_RETRIES, undefined)
  session.closeInput()
})

test("an envelope stamp removes the silent fallback and hidden retries and caps the SDK budget", () => {
  const { captured, session } = run({ ledger: ENVELOPE })
  const options = captured[0]
  assert.equal("fallbackModel" in options!, false)
  assert.equal(options!.maxBudgetUsd, 0.5)
  assert.equal(options!.env!.CLAUDE_CODE_MAX_RETRIES, "0")
  assert.ok(Array.isArray(options!.hooks?.PreToolUse))
  assert.equal(typeof session.resolveCallReserve, "function")
  session.closeInput()
})

test("a per-call stamp is not an envelope: the Agent SDK path stays ungated", () => {
  const { captured, session } = run({ ledger: { ...ENVELOPE, mode: "per_call" } })
  assert.equal(captured[0]!.fallbackModel, "claude-haiku-4-5")
  assert.equal(captured[0]!.env!.CLAUDE_CODE_MAX_RETRIES, undefined)
  session.closeInput()
})

test("the envelope tool hook denies the tool and stops the run on a refusal", async () => {
  const events: Record<string, unknown>[] = []
  const gate = createCallLedgerGate({
    ledger: ENVELOPE,
    sessionId: "s1",
    emit: (e) => events.push(e),
  })
  const refusals: CallRefusal[] = []
  const hooks = buildLedgerToolHooks({ gate, onRefused: (r) => refusals.push(r) })
  const hook = hooks!.PreToolUse[0]!.hooks[0]

  const allowed = hook!(
    {
      hook_event_name: "PreToolUse",
      session_id: "s",
      transcript_path: "",
      cwd: "/",
      tool_name: "Bash",
      tool_input: {},
      tool_use_id: "t",
    },
    undefined,
    { signal: new AbortController().signal }
  )
  const first = events.at(-1)
  assert.deepEqual(
    [first!.type, first!.kind, first!.toolName],
    ["call_reserve_request", "envelope_check", "Bash"]
  )
  gate.resolveDecision({ requestId: first!.requestId, decision: "granted" })
  assert.deepEqual(await allowed, {})

  const denied = hook!(
    {
      hook_event_name: "PreToolUse",
      session_id: "s",
      transcript_path: "",
      cwd: "/",
      tool_name: "Write",
      tool_input: {},
      tool_use_id: "t",
    },
    undefined,
    { signal: new AbortController().signal }
  )
  gate.resolveDecision({
    requestId: events.at(-1)!.requestId,
    decision: "refused",
    code: "MAX_MODEL_CALLS",
  })
  const output = (await denied) as {
    hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string }
  }
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny")
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /MAX_MODEL_CALLS/)
  assert.deepEqual(refusals, [{ decision: "refused", code: "MAX_MODEL_CALLS" }])

  assert.equal(
    buildLedgerToolHooks({
      gate: createCallLedgerGate({ ledger: null, sessionId: "s1", emit() {} }),
      onRefused() {},
    }),
    undefined
  )
})

test("a refused envelope check interrupts the query, so no further model call is made", async () => {
  const { captured, interrupts, events, session } = run({ ledger: ENVELOPE })
  const hook = captured[0]!.hooks!.PreToolUse!.at(-1)!.hooks[0]
  const denied = hook!(
    {
      hook_event_name: "PreToolUse",
      session_id: "s",
      transcript_path: "",
      cwd: "/",
      tool_name: "Write",
      tool_input: {},
      tool_use_id: "t",
    },
    undefined,
    { signal: new AbortController().signal }
  )
  const request = events.filter((e) => e.type === "call_reserve_request").at(-1)
  session.resolveCallReserve({
    requestId: request!.requestId,
    decision: "refused",
    code: "RUN_BUDGET_EXHAUSTED",
  })
  const output = (await denied) as {
    hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string }
  }
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny")
  // The interrupt is scheduled off the hook's own microtask.
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(interrupts, [true])
  session.closeInput()
})
