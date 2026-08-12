import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

import { canonicalEventsFromSdkMessage, createSdkMappingState } from "./sdk-canonical-events.mjs"

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const MANIFEST = JSON.parse(
  readFileSync(join(REPO_ROOT, "protocol", "agent-sdk-surface.json"), "utf8")
)

/**
 * Minimal payloads that satisfy each member's non-optional fields. Keyed by
 * `subtype` for `system`, by `type` otherwise — the same discriminants the
 * manifest records.
 */
const SAMPLES = {
  assistant: { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } },
  user: { type: "user", message: { content: [{ type: "text", text: "yo" }] } },
  "user:replay": { type: "user", isReplay: true, uuid: "u-1", message: { content: [] } },
  result: { type: "result", subtype: "success", is_error: false, usage: { input_tokens: 1 } },
  stream_event: {
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "x" } },
  },
  tool_progress: {
    type: "tool_progress",
    tool_use_id: "t1",
    tool_name: "Bash",
    elapsed_time_seconds: 2,
  },
  tool_use_summary: { type: "tool_use_summary", summary: "s", preceding_tool_use_ids: ["t1"] },
  auth_status: { type: "auth_status", isAuthenticating: false, output: [] },
  rate_limit_event: { type: "rate_limit_event", rate_limit_info: { status: "allowed_warning" } },
  prompt_suggestion: { type: "prompt_suggestion", suggestion: "try this" },
  conversation_reset: { type: "conversation_reset", new_conversation_id: "c-2" },

  "system:init": { subtype: "init", model: "claude-opus-5", cwd: "/w", tools: [], mcp_servers: [] },
  "system:compact_boundary": { subtype: "compact_boundary", compact_metadata: { trigger: "auto" } },
  "system:status": { subtype: "status", status: "requesting" },
  "system:api_retry": { subtype: "api_retry", attempt: 1, max_retries: 3, error_status: 529 },
  "system:control_request_progress": {
    subtype: "control_request_progress",
    request_id: "r1",
    status: "started",
  },
  "system:model_refusal_fallback": {
    subtype: "model_refusal_fallback",
    original_model: "a",
    fallback_model: "b",
    direction: "retry",
    content: "refused",
  },
  "system:model_refusal_no_fallback": {
    subtype: "model_refusal_no_fallback",
    original_model: "a",
    content: "refused",
  },
  "system:local_command_output": { subtype: "local_command_output", content: "out" },
  "system:hook_started": {
    subtype: "hook_started",
    hook_id: "h",
    hook_name: "n",
    hook_event: "PreToolUse",
  },
  "system:hook_progress": {
    subtype: "hook_progress",
    hook_id: "h",
    hook_name: "n",
    hook_event: "PreToolUse",
    output: "o",
  },
  "system:hook_response": {
    subtype: "hook_response",
    hook_id: "h",
    hook_name: "n",
    hook_event: "PreToolUse",
    output: "o",
    outcome: "success",
  },
  "system:plugin_install": { subtype: "plugin_install", status: "installed", name: "p" },
  "system:task_started": { subtype: "task_started", task_id: "k1", description: "d" },
  "system:task_updated": { subtype: "task_updated", task_id: "k1", patch: { status: "running" } },
  "system:task_progress": { subtype: "task_progress", task_id: "k1", description: "d", usage: {} },
  "system:task_notification": {
    subtype: "task_notification",
    task_id: "k1",
    status: "completed",
    output_file: "/f",
    summary: "s",
  },
  "system:background_tasks_changed": { subtype: "background_tasks_changed", tasks: [] },
  "system:thinking_tokens": {
    subtype: "thinking_tokens",
    estimated_tokens: 10,
    estimated_tokens_delta: 2,
  },
  "system:session_state_changed": { subtype: "session_state_changed", state: "requires_action" },
  "system:worker_shutting_down": { subtype: "worker_shutting_down", reason: "idle" },
  "system:commands_changed": { subtype: "commands_changed", commands: [] },
  "system:notification": { subtype: "notification", key: "k", text: "t", priority: "low" },
  "system:files_persisted": {
    subtype: "files_persisted",
    files: [],
    failed: [],
    processed_at: "now",
  },
  "system:memory_recall": { subtype: "memory_recall", mode: "select", memories: [] },
  "system:elicitation_complete": {
    subtype: "elicitation_complete",
    mcp_server_name: "m",
    elicitation_id: "e1",
  },
  "system:permission_denied": {
    subtype: "permission_denied",
    tool_name: "Bash",
    tool_use_id: "t1",
    message: "no",
  },
  "system:mirror_error": {
    subtype: "mirror_error",
    error: "disk full",
    key: { projectKey: "p", sessionId: "s" },
  },
  "system:informational": { subtype: "informational", content: "c", level: "notice" },
}

/** Sample for a manifest entry, using its recorded `wire` discriminants. */
function sampleFor(name, wire) {
  if (name === "SDKUserMessageReplay") return SAMPLES["user:replay"]
  if (wire.type !== "system") return SAMPLES[wire.type]
  const sub = SAMPLES[`system:${wire.subtypes[0]}`]
  return sub ? { type: "system", ...sub } : undefined
}

test("every manifest message maps to the canonical kinds it declares", () => {
  const entries = Object.entries(MANIFEST.surface.messages)
  assert.equal(entries.length, 39, "the union should still have 39 members")

  const unmapped = []
  for (const [name, entry] of entries) {
    const sample = sampleFor(name, entry.wire)
    assert.ok(sample, `no sample payload for ${name}`)

    const events = canonicalEventsFromSdkMessage(sample, createSdkMappingState())
    assert.ok(events.length > 0, `${name} produced no canonical event`)

    for (const ev of events) {
      if (ev.kind === "diagnostic") unmapped.push(`${name} -> diagnostic`)
      assert.ok(
        entry.canonical.includes(ev.kind),
        `${name} produced "${ev.kind}", not in the manifest's [${entry.canonical.join(", ")}]`
      )
    }
  }

  // The whole point of the exercise: nothing lands on the swallow branch.
  assert.deepEqual(unmapped, [])
})

test("an assistant turn yields one tool-call per tool_use block", () => {
  const events = canonicalEventsFromSdkMessage(
    {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "let me look" },
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
          { type: "tool_use", id: "t2", name: "Read", input: { file: "a" } },
        ],
      },
    },
    createSdkMappingState()
  )
  assert.deepEqual(
    events.map((e) => e.kind),
    ["text-delta", "tool-call", "tool-call"]
  )
  assert.equal(events[1].toolCallId, "t1")
  assert.deepEqual(events[2].input, { file: "a" })
})

test("assistant text is suppressed once partials have streamed it", () => {
  const state = createSdkMappingState()
  const assistant = {
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "hello" },
        { type: "tool_use", id: "t1", name: "Bash", input: {} },
      ],
    },
  }

  // Without partials the authoritative message carries the text.
  assert.deepEqual(
    canonicalEventsFromSdkMessage(assistant, createSdkMappingState()).map((e) => e.kind),
    ["text-delta", "tool-call"]
  )

  // With partials it must not be emitted twice — the deltas already were.
  canonicalEventsFromSdkMessage(SAMPLES.stream_event, state)
  assert.deepEqual(
    canonicalEventsFromSdkMessage(assistant, state).map((e) => e.kind),
    ["tool-call"]
  )
})

test("control-only stream frames do not suppress an assistant text snapshot", () => {
  const state = createSdkMappingState()

  canonicalEventsFromSdkMessage(
    {
      type: "stream_event",
      event: { type: "message_start", message: { id: "m-control" } },
    },
    state
  )
  canonicalEventsFromSdkMessage({ type: "stream_event", event: { type: "step_start" } }, state)

  assert.deepEqual(
    canonicalEventsFromSdkMessage(
      {
        type: "assistant",
        message: { id: "m-control", content: [{ type: "text", text: "snapshot fallback" }] },
      },
      state
    ),
    [{ kind: "text-delta", delta: "snapshot fallback" }]
  )
})

test("a streamed assistant message does not suppress a later snapshot-only round", () => {
  const state = createSdkMappingState()

  canonicalEventsFromSdkMessage(
    {
      type: "stream_event",
      event: { type: "message_start", message: { id: "m-streamed" } },
    },
    state
  )
  canonicalEventsFromSdkMessage(
    {
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "first" } },
    },
    state
  )

  assert.deepEqual(
    canonicalEventsFromSdkMessage(
      {
        type: "assistant",
        message: { id: "m-snapshot", content: [{ type: "text", text: "second round" }] },
      },
      state
    ),
    [{ kind: "text-delta", delta: "second round" }]
  )
})

test("a user turn splits text from tool results", () => {
  const events = canonicalEventsFromSdkMessage(
    {
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "ok", is_error: false },
          { type: "text", text: "and also" },
        ],
      },
    },
    createSdkMappingState()
  )
  assert.deepEqual(
    events.map((e) => e.kind),
    ["user-input", "tool-result"]
  )
  assert.equal(events[1].toolCallId, "t1")
  assert.equal(events[1].isError, undefined, "false should not be serialized")
})

test("a replay carries the id checkpointing needs, not a second user turn", () => {
  const [ev] = canonicalEventsFromSdkMessage(
    {
      type: "user",
      isReplay: true,
      uuid: "msg-9",
      message: { content: [{ type: "text", text: "original prompt" }] },
    },
    createSdkMappingState()
  )
  assert.equal(ev.kind, "user-replay")
  assert.equal(ev.messageId, "msg-9")
  assert.equal(ev.preview, "original prompt")
})

test("a failing result reports the SDK subtype as the failure code", () => {
  const events = canonicalEventsFromSdkMessage(
    { type: "result", subtype: "error_max_turns", is_error: true, usage: {} },
    createSdkMappingState()
  )
  assert.deepEqual(
    events.map((e) => e.kind),
    ["usage", "failure"]
  )
  assert.equal(events[1].code, "error_max_turns")
  assert.equal(events[1].retryable, undefined, "a turn ceiling is policy, not a transient fault")
})

// ---- structured output ------------------------------------------------------

const structured = (evt) =>
  canonicalEventsFromSdkMessage(evt, createSdkMappingState({ expectStructuredOutput: true }))

test("a turn with no schema requested emits no structured-output event", () => {
  const events = canonicalEventsFromSdkMessage(
    { type: "result", subtype: "success", is_error: false, structured_output: { a: 1 } },
    createSdkMappingState()
  )
  assert.deepEqual(
    events.map((e) => e.kind),
    ["lifecycle"]
  )
})

test("a satisfied schema rides its own event, before the lifecycle", () => {
  const events = structured({
    type: "result",
    subtype: "success",
    is_error: false,
    usage: {},
    result: "prose",
    structured_output: { ok: true },
  })
  assert.deepEqual(
    events.map((e) => e.kind),
    ["usage", "structured-output", "lifecycle"]
  )
  assert.deepEqual(events[1], { kind: "structured-output", status: "ok", output: { ok: true } })
})

test("the raw answer is NOT copied into the structured-output event", () => {
  // It already reached consumers as text-delta events and on the result
  // message; a third copy would bloat every persisted turn.
  const [ev] = structured({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "a very long prose answer",
    structured_output: {},
  })
  assert.equal("raw" in ev, false)
})

test("a SUCCESSFUL turn with no structured output settles as a failure", () => {
  // The whole point: the SDK says success, so `lifecycle: ended` would tell
  // every consumer the turn worked while the caller holds `undefined`.
  const events = structured({ type: "result", subtype: "success", is_error: false, result: "hi" })
  assert.deepEqual(
    events.map((e) => e.kind),
    ["structured-output", "failure"]
  )
  assert.equal(events[0].status, "missing")
  assert.equal(events[1].code, "structured_output_missing")
  assert.equal(events[1].retryable, true, "prose once does not mean prose again")
  assert.equal(
    events.some((e) => e.kind === "lifecycle"),
    false,
    "a turn that failed its contract must not also report a clean end"
  )
})

test("exhausted schema retries keep the SDK's own failure code", () => {
  const events = structured({
    type: "result",
    subtype: "error_max_structured_output_retries",
    is_error: true,
  })
  assert.deepEqual(
    events.map((e) => e.kind),
    ["structured-output", "failure"]
  )
  assert.equal(events[0].status, "retries-exhausted")
  assert.equal(events[1].code, "error_max_structured_output_retries")
  assert.equal(events[1].retryable, undefined, "the SDK already retried to exhaustion")
})

test("a budget ceiling is reported as incomplete, not as a schema failure", () => {
  const events = structured({ type: "result", subtype: "error_max_budget_usd", is_error: true })
  assert.equal(events[0].status, "turn-incomplete")
  assert.equal(events[1].code, "error_max_budget_usd")
})

test("mirror_error is a durability alarm, never a turn failure", () => {
  const [ev] = canonicalEventsFromSdkMessage(
    {
      type: "system",
      subtype: "mirror_error",
      error: "disk full",
      key: { projectKey: "p", sessionId: "s", subpath: "sub" },
    },
    createSdkMappingState()
  )
  assert.equal(ev.kind, "mirror-error")
  assert.equal(ev.subpath, "sub")
})

test("memory recall records provenance but never the recalled body", () => {
  const [ev] = canonicalEventsFromSdkMessage(
    {
      type: "system",
      subtype: "memory_recall",
      mode: "synthesize",
      memories: [{ path: "/m", scope: "team", content: "SECRET BODY" }],
    },
    createSdkMappingState()
  )
  assert.deepEqual(ev.memories, [{ path: "/m", scope: "team" }])
  assert.ok(!JSON.stringify(ev).includes("SECRET BODY"))
})

test("the synthetic hook_fire subtype maps even though the SDK does not declare it", () => {
  const [ev] = canonicalEventsFromSdkMessage(
    {
      type: "system",
      subtype: "hook_fire",
      hook_event: "PreToolUse",
      outcome: "blocked",
      block: "denied by policy",
      uuid: "h-1",
    },
    createSdkMappingState()
  )
  assert.equal(ev.kind, "hook")
  assert.equal(ev.blocked, true)
  assert.equal(ev.blockReason, "denied by policy")
})

test("the synthetic hook_audit subtype preserves structured policy metadata", () => {
  const [ev] = canonicalEventsFromSdkMessage(
    {
      type: "system",
      subtype: "hook_audit",
      hookId: "h-2",
      hookEvent: "Stop",
      provider: "claude",
      handlerType: "http",
      policyClass: "managed",
      outcome: "warning",
      latencyMs: 12,
      redacted: true,
      error: "timeout",
    },
    createSdkMappingState()
  )
  assert.deepEqual(ev, {
    kind: "hook",
    phase: "completed",
    hookId: "h-2",
    hookName: "http",
    hookEvent: "Stop",
    outcome: "error",
    provider: "claude",
    handlerType: "http",
    policyClass: "managed",
    latencyMs: 12,
    redacted: true,
    error: "timeout",
  })
})

test("an unknown member is preserved as a diagnostic rather than dropped", () => {
  const [ev] = canonicalEventsFromSdkMessage(
    { type: "teleport", payload: 1 },
    createSdkMappingState()
  )
  assert.equal(ev.kind, "diagnostic")
  assert.equal(ev.runtime, "claude-agent-sdk")
})

test("a rate-limit event with no info yields nothing to log", () => {
  assert.deepEqual(
    canonicalEventsFromSdkMessage({ type: "rate_limit_event" }, createSdkMappingState()),
    []
  )
})

test("non-objects are ignored", () => {
  assert.deepEqual(canonicalEventsFromSdkMessage(null, createSdkMappingState()), [])
  assert.deepEqual(canonicalEventsFromSdkMessage("nope", createSdkMappingState()), [])
})
