import test from "node:test"
import assert from "node:assert/strict"

import { dispatch, validateRuntimeFeatures } from "./index.ts"

test("new feature requests honor both the frozen capability ceiling and the actual adapter", () => {
  const requests = [
    { subagentRuntime: { contextMode: "fork" as const } },
    { toolPermissionRules: [{ tool: "mcp__notes__write", decision: "ask" as const }] },
    { runtimeExtensions: [{ kind: "directory" as const, path: "/workspace/plugin" }] },
    {
      agents: {
        child: {
          description: "Review",
          prompt: "Review",
          contextPolicy: { compactAtTokens: 1000 },
        },
      },
    },
  ]
  for (const request of requests) {
    const events: Record<string, unknown>[] = []
    assert.throws(
      () =>
        validateRuntimeFeatures({
          sessionId: "s",
          sendOptions: {
            ...request,
            execution: { runtimeAdapter: "claude-agent-sdk", capabilities: { effective: [] } },
          },
          emit: (event) => events.push(event),
        }),
      /capability/
    )
    assert.equal(events[0]?.type, "capability_error")
  }
  assert.throws(
    () =>
      validateRuntimeFeatures({
        sessionId: "s",
        sendOptions: {
          subagentRuntime: { contextMode: "fork" },
          execution: { runtimeAdapter: "claude-agent-sdk" },
        },
        emit() {},
      }),
    /capability/
  )
  assert.throws(
    () =>
      validateRuntimeFeatures({
        sessionId: "s",
        sendOptions: {
          subagentRuntime: { contextMode: "fork" },
          execution: {
            runtimeAdapter: "ai-sdk",
            capabilities: { effective: ["subagents.context-fork"] },
          },
        },
        emit() {},
      }),
    /capability/
  )
  assert.doesNotThrow(() =>
    validateRuntimeFeatures({
      sessionId: "s",
      sendOptions: {
        toolPermissionRules: [{ tool: "mcp__notes__write", decision: "ask" }],
        execution: {
          runtimeAdapter: "ai-sdk",
          capabilities: { effective: ["tools.permission-policy"] },
        },
      },
      emit() {},
    })
  )
})

test("unsupported portable subagent capabilities fail before an engine runs", () => {
  for (const sendOptions of [
    { provider: "openai", subagentRuntime: { contextMode: "fork" as const } },
    {
      provider: "openai",
      agents: {
        child: {
          description: "Review",
          prompt: "Review",
          contextPolicy: { compactAtTokens: 1000 },
        },
      },
    },
  ]) {
    const events: unknown[] = []
    assert.throws(
      () =>
        dispatch({
          sessionId: "test",
          firstPrompt: "hello",
          sendOptions,
          emit: (event) => events.push(event),
          log() {},
        }),
      /capability/
    )
    assert.equal((events[0] as { type: string }).type, "capability_error")
  }
})

/**
 * A frame naming a runtime this host cannot serve must say which of the two
 * things went wrong. `external` is a KNOWN adapter that lives in the renderer's
 * external-agent manager, so a turn arriving here with it was routed to the
 * wrong executor. Anything else is version skew between the resolver and this
 * host.
 */
test("refuses the external adapter by naming the executor it belongs to", () => {
  assert.throws(
    () =>
      dispatch({
        sessionId: "test",
        firstPrompt: "hello",
        emit() {},
        log() {},
        sendOptions: { execution: { runtimeAdapter: "external" } },
      }),
    /external-agent manager/
  )
})

test("refuses an adapter it has never heard of as skew", () => {
  assert.throws(
    () =>
      dispatch({
        sessionId: "test",
        firstPrompt: "hello",
        emit() {},
        log() {},
        sendOptions: { execution: { runtimeAdapter: "from-the-future" } },
      }),
    /unknown frozen runtimeAdapter: from-the-future/
  )
})
