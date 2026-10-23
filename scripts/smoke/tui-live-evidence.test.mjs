import { test } from "node:test"
import assert from "node:assert/strict"
import {
  completedSubagentResult,
  freshCommandResult,
  newToolNames,
  redactArtifact,
  requestContextEvidence,
  successfulStep,
  recordedReadPaths,
  hostToolResults,
  ownedProcessIds,
  renderedPaste,
  projectRecallEvidence,
  sourceCorrectionEvidence,
  completedInferenceEvidence,
  createSourceReadObserver,
  sourceFindingEvidence,
} from "./tui-live-evidence.mjs"

test("only structurally identified summary cancellation can replace a completed stream", () => {
  const messages = [
    { role: "system", content: "Summarize only" },
    {
      role: "user",
      content:
        "Summarize the conversation transcript below. It is material to summarize, not a new task.\n<transcript>evidence</transcript>",
    },
  ]
  assert.equal(requestContextEvidence(messages).summaryCall, true)
  assert.equal(
    requestContextEvidence([...messages, { role: "assistant", content: "reply" }]).summaryCall,
    false
  )
  const aborted = { status: 200, cancelled: true, error: "aborted", toolNames: [] }
  assert.throws(() => completedInferenceEvidence([aborted]))
  assert.throws(() =>
    completedInferenceEvidence([{ ...aborted, summaryCall: true, streamError: true }])
  )
  assert.throws(() =>
    completedInferenceEvidence([{ ...aborted, summaryCall: true, toolNames: ["read"] }])
  )
  assert.deepEqual(
    completedInferenceEvidence([
      { ...aborted, summaryCall: true },
      { status: 200, completed: true },
    ]),
    { cancelledSummaries: 1 }
  )
})

test("source correction must explicitly supersede the obsolete finding", () => {
  const change = { obsolete: "OLD_FACT", revised: "NEW_FACT" }
  assert.throws(() => sourceCorrectionEvidence("OLD_FACT NEW_FACT", change))
  assert.throws(() => sourceCorrectionEvidence("Source correction: OLD_FACT -> OTHER", change))
  assert.equal(sourceCorrectionEvidence("Source correction: OLD_FACT -> NEW_FACT", change), true)
  assert.equal(
    sourceCorrectionEvidence(
      "**Explicit supersede:** Source correction: OLD_FACT -> NEW_FACT",
      change
    ),
    true
  )
  assert.equal(
    sourceCorrectionEvidence("Source correction: `OLD_FACT` -> `NEW_FACT`", change),
    true
  )
  assert.equal(
    sourceCorrectionEvidence(
      "**Source correction (as produced by the child):** `OLD_FACT` → `NEW_FACT`",
      change
    ),
    true
  )
  assert.throws(() =>
    sourceCorrectionEvidence("Source correction: OLD_FACT -> NEW_FACT_OTHER", change)
  )
  const structured = (code, behavior) =>
    `<source-findings>${JSON.stringify([{ code, behavior }])}</source-findings>`
  assert.equal(
    sourceCorrectionEvidence(
      structured("NEW_FACT", "Verified current finding; supersedes OLD_FACT."),
      change
    ),
    true
  )
  assert.throws(() =>
    sourceCorrectionEvidence(structured("NEW_FACT", "OLD_FACT and NEW_FACT both appeared."), change)
  )
  assert.throws(() =>
    sourceCorrectionEvidence(structured("NEW_FACT_OTHER", "supersedes OLD_FACT"), change)
  )
})

test("the final read is observed even when a budget stop prevents a subsequent request", () => {
  const observer = createSourceReadObserver()
  observer.observe({
    index: 0,
    id: "last",
    function: { name: "read", arguments: '{"file_path":"research/' },
  })
  observer.observe({ index: 0, function: { arguments: 'page.ts","limit":400}' } })
  assert.deepEqual(observer.reads(), [
    { id: "last", path: "research/page.ts", offset: undefined, limit: 400 },
  ])
})

test("behavior acceptance rejects complete codes with lost semantic findings", () => {
  const manifest = [{ fact: "CODE", file: "research/page.ts", source: "src/real.ts" }]
  const report = (behavior) =>
    `<source-findings>${JSON.stringify([{ code: "CODE", behavior, source: "research/page.ts:1 src/real.ts:1" }])}</source-findings>`
  assert.throws(() => sourceFindingEvidence(report("not retained in surviving context"), manifest))
  assert.throws(() => sourceFindingEvidence("CODE src/real.ts:1", manifest))
  assert.equal(
    sourceFindingEvidence(
      "The `<source-findings>` array follows.\n" +
        report("Abort preserves completed tool evidence before closing."),
      manifest
    ).length,
    1
  )
  assert.equal(
    sourceFindingEvidence(
      "### Evidence appendix — complete `<source-findings>`\n```json\n" +
        JSON.stringify([
          {
            code: "CODE",
            behavior: "Abort preserves completed tool evidence before closing.",
            source: "research/page.ts:1 src/real.ts:1",
          },
        ]) +
        "\n```",
      manifest
    ).length,
    1
  )
  assert.equal(
    sourceFindingEvidence(
      report("Abort preserves completed tool evidence before closing."),
      manifest
    ).length,
    1
  )
  assert.equal(
    sourceFindingEvidence(
      report("classifyRef maps extensions to image | pdf | rich | text | unknown."),
      manifest
    ).length,
    1
  )
  assert.throws(() =>
    sourceFindingEvidence(report("Behavior unknown from retained context."), manifest)
  )
})

test("project recall requires structured completed state and the independently counted tests", () => {
  assert.throws(() => projectRecallEvidence("import atomic transaction idempotent", 103))
  const state = {
    entry: "src/cli.mjs",
    tests: 103,
    completed: { csvImport: true, atomicPersistence: true, idempotentImport: true },
    pending: [],
  }
  assert.deepEqual(projectRecallEvidence(JSON.stringify(state), 103), state)
  assert.deepEqual(
    projectRecallEvidence(
      `\`\`\`json\n${JSON.stringify(state)}\n\`\`\`\nBasis: verified project evidence.`,
      103
    ),
    state
  )
  assert.throws(() => projectRecallEvidence(JSON.stringify({ ...state, tests: 95 }), 103))
  assert.throws(() =>
    projectRecallEvidence(JSON.stringify({ ...state, pending: ["implement import"] }), 103)
  )
})

test("long paste acknowledgement accepts the visible composer tail, not old history", () => {
  const prompt = "long prefix ".repeat(90) + "final complete command"
  assert.equal(renderedPaste(`╭──╮\n│ final complete command█ │\n╰──╯`, prompt), false)
  assert.equal(renderedPaste(`╭──╮\n│ ${prompt.slice(-140)}█ │\n╰──╯`, prompt), true)
  assert.equal(renderedPaste(`${prompt.slice(-140)}\n╭──╮\n│ › █ │\n╰──╯`, prompt), false)
  assert.equal(renderedPaste(`› short prompt█`, "short prompt"), true)
})

test("owned process inventory includes nested children and excludes unrelated sessions", () => {
  assert.deepEqual(
    ownedProcessIds("PID PPID\n40 30\n30 20\n20 1\n99 1\n100 99\n", 20),
    [20, 30, 40]
  )
})

test("host tool evidence requires a matched real result and retains no body", () => {
  const evidence = hostToolResults(
    [
      { role: "user", content: "PLUGIN_OK" },
      { role: "tool", tool_call_id: "unknown", content: '{"ok":true}' },
      {
        role: "assistant",
        tool_calls: [
          { id: "a", function: { name: "plugin_probe" } },
          { id: "b", function: { name: "load_skill" } },
        ],
      },
      { role: "tool", tool_call_id: "a", content: '{"ok":true,"private":"not persisted"}' },
      { role: "tool", tool_call_id: "b", content: "secret fact PROBE_VALUE" },
    ],
    "PROBE_VALUE"
  )
  assert.equal(evidence.length, 2)
  assert.equal(evidence[0].ok, true)
  assert.equal(evidence[1].containsProbe, true)
  assert.equal(JSON.stringify(evidence).includes("not persisted"), false)
  assert.equal(JSON.stringify(evidence).includes("secret fact"), false)
})

test("budget evidence proves the last completed read even without a later model request", () => {
  const entry = JSON.stringify({
    tool: "read",
    input: { file_path: "/source/a.ts" },
    failed: false,
    result: "x".repeat(4000),
  })
  const clipped = `${entry.slice(0, 1000)}\n[truncated]\n${entry.slice(-1000)}`
  const failed = JSON.stringify({
    tool: "read",
    input: { file_path: "/missing.ts" },
    failed: true,
    result: "missing",
  })
  assert.deepEqual(recordedReadPaths(`Evidence\n${clipped}\n${failed}`), ["/source/a.ts"])
})

test("an expected product error cannot overwrite a successful acceptance check", () => {
  assert.deepEqual(
    successfulStep(
      "budget",
      { status: "error", runStatus: "error", name: "other", partialEvidenceRetained: true },
      2
    ),
    {
      status: "passed",
      runStatus: "error",
      name: "budget",
      partialEvidenceRetained: true,
      seconds: 2,
    }
  )
})

test("request evidence extracts published checkpoints and read identities without retaining bodies", () => {
  const state = { goal: "test", items: [{ id: "read", status: "done", summary: "known" }] }
  const evidence = requestContextEvidence([
    {
      role: "user",
      content: `<conversation-summary version="1">\n<research-progress>\n${JSON.stringify(state)}\n</research-progress>\nYou previously worked on this task:\ntask\nYour result was:\nfact`,
    },
    {
      role: "assistant",
      tool_calls: [
        {
          id: "call-1",
          function: { name: "read", arguments: '{"file_path":"code.ts","limit":400}' },
        },
        { id: "broken", function: { name: "read", arguments: "bad" } },
      ],
    },
  ])
  assert.equal(evidence.hasSummary, true)
  assert.equal(evidence.resumedChild, true)
  assert.deepEqual(evidence.checkpoints, [state])
  assert.deepEqual(evidence.sourceReads, [
    { id: "call-1", path: "code.ts", offset: undefined, limit: 400 },
  ])
  assert.equal("messages" in evidence, false)
  assert.deepEqual(
    requestContextEvidence([{ content: "<research-progress>not JSON</research-progress>" }])
      .checkpoints,
    []
  )
})

test("redact after joining PTY chunks protects a credential split across frames", () => {
  const secret = "fixture-key-only"
  const raw = ["prefix fixture-", "key-only suffix"].map((s) => redactArtifact(s, secret)).join("")
  assert.ok(raw.includes(secret))
  assert.equal(redactArtifact(raw, secret), "prefix [REDACTED] suffix")
})
test("tool evidence excludes inherited calls from previous turns", () => {
  const content = [
    { type: "tool-call", toolCallId: "old", toolName: "bash" },
    { type: "tool-call", toolCallId: "new", toolName: "read" },
  ]
  assert.deepEqual(newToolNames([{ content }], new Set(["old"])), ["read"])
})
test("a typed slash command and stale frame are not controller results", () => {
  const input = {
    text: "› /limits",
    revision: 2,
    before: 1,
    command: "/limits",
    pattern: /limits/i,
  }
  assert.equal(freshCommandResult(input), false)
  assert.equal(freshCommandResult({ ...input, text: "Limits", revision: 1 }), false)
  assert.equal(freshCommandResult({ ...input, text: "Limits" }), true)
})
test("subagent fact must occur in its completed result, not in old chat", () => {
  assert.throws(() =>
    completedSubagentResult('old ORCHID\nSubagent "Explore" failed: transport', "Explore", "ORCHID")
  )
  assert.throws(() =>
    completedSubagentResult('old ORCHID\nSubagent "Explore": unrelated result', "Explore", "ORCHID")
  )
  assert.match(
    completedSubagentResult('Subagent "Explore"  (100 tok):\nORCHID', "Explore", "ORCHID"),
    /ORCHID/
  )
})
test("HTTP success and source facts cannot hide a subagent budget stop", () => {
  for (const reason of [
    "error_max_turns",
    "error_max_budget_usd",
    "cancelled",
    "interrupted",
    "unknown_terminal",
  ]) {
    assert.throws(() =>
      completedSubagentResult(
        `Subagent "Explore"  (100 tok · ${reason}):\nORCHID`,
        "Explore",
        "ORCHID"
      )
    )
  }
})
