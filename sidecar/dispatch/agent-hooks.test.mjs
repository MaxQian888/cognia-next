import { test } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  matcherMatches,
  extractDecision,
  parseZeroExitOutput,
  mergeOutcome,
  runGroups,
  runCommandHandler,
  runWebhookHandler,
  mapDecisionToOutput,
  hookFireOutcome,
  buildHookFirePayload,
  buildAgentHooks,
  mergeHookMaps,
} from "./agent-hooks.mjs"

// A cross-platform command string: `node -e "<js>"` runs under both `cmd /C`
// (Windows) and `sh -c` (POSIX). Keep the JS single-quoted to avoid nested
// double quotes tripping cmd.exe.
const nodeCmd = (js) => `node -e "${js}"`

// --- matcher ----------------------------------------------------------------

test("matcherMatches: omitted / empty / star match all", () => {
  assert.equal(matcherMatches(undefined, "Bash"), true)
  assert.equal(matcherMatches(null, "Bash"), true)
  assert.equal(matcherMatches("", "Bash"), true)
  assert.equal(matcherMatches("   ", "Bash"), true)
  assert.equal(matcherMatches("*", "Bash"), true)
})

test("matcherMatches: pipe-set is exact match", () => {
  assert.equal(matcherMatches("Bash|Edit", "Bash"), true)
  assert.equal(matcherMatches("Bash|Edit", "Edit"), true)
  assert.equal(matcherMatches("Bash|Edit", "Read"), false)
})

test("matcherMatches: non-literal is regex, invalid regex is false", () => {
  assert.equal(matcherMatches("^Notebook", "NotebookEdit"), true)
  assert.equal(matcherMatches("^Notebook", "Read"), false)
  assert.equal(matcherMatches("mcp__.*__write.*", "mcp__github__write_file"), true)
  assert.equal(matcherMatches("(", "anything"), false)
})

// --- extractDecision / parseZeroExitOutput ----------------------------------

test("extractDecision: permissionDecision deny (nested + top-level)", () => {
  assert.equal(
    extractDecision({ permissionDecision: "deny", decisionReason: "nope" }).block,
    "nope"
  )
  assert.equal(
    extractDecision({
      hookSpecificOutput: { permissionDecision: "block", permissionDecisionReason: "policy" },
    }).block,
    "policy"
  )
  assert.equal(
    extractDecision({ permissionDecision: "deny" }).block,
    "hook returned permissionDecision=deny"
  )
})

test("extractDecision: legacy decision=block", () => {
  assert.equal(extractDecision({ decision: "block", reason: "stop" }).block, "stop")
  assert.equal(extractDecision({ decision: "block" }).block, "hook returned decision=block")
})

test("extractDecision: ask / allow / additionalContext / mutations", () => {
  assert.equal(extractDecision({ permissionDecision: "ask" }).permissionDecision, "ask")
  assert.equal(extractDecision({ permissionDecision: "allow" }).permissionDecision, "allow")
  assert.equal(extractDecision({ additionalContext: "hi" }).additionalContext, "hi")
  assert.deepEqual(extractDecision({ updatedInput: { command: "ls" } }).updatedInput, {
    command: "ls",
  })
  assert.equal(extractDecision({ updatedToolOutput: "patched" }).updatedToolOutput, "patched")
  assert.equal(extractDecision({ updatedMCPToolOutput: "mcp" }).updatedToolOutput, "mcp")
})

test("parseZeroExitOutput: empty allow, JSON decision, plain text context", () => {
  assert.deepEqual(parseZeroExitOutput(""), {})
  assert.deepEqual(parseZeroExitOutput("   "), {})
  assert.equal(parseZeroExitOutput('{"additionalContext":"x"}').additionalContext, "x")
  assert.equal(parseZeroExitOutput("just text").additionalContext, "just text")
})

// --- mergeOutcome -----------------------------------------------------------

test("mergeOutcome: first block wins, contexts concatenated, mutations last-wins", () => {
  const dec = { warnings: [] }
  mergeOutcome(dec, { additionalContext: "a" })
  mergeOutcome(dec, { additionalContext: "b" })
  assert.equal(dec.additionalContext, "a\n\nb")
  mergeOutcome(dec, { block: "first" })
  mergeOutcome(dec, { block: "second" })
  assert.equal(dec.block, "first")
  mergeOutcome(dec, { updatedInput: { a: 1 } })
  mergeOutcome(dec, { updatedInput: { a: 2 } })
  assert.deepEqual(dec.updatedInput, { a: 2 })
  mergeOutcome(dec, { warning: "w1" })
  assert.deepEqual(dec.warnings, ["w1"])
})

test("mergeOutcome: ask escalates over allow", () => {
  const dec = { warnings: [] }
  mergeOutcome(dec, { permissionDecision: "allow" })
  assert.equal(dec.permissionDecision, "allow")
  mergeOutcome(dec, { permissionDecision: "ask" })
  assert.equal(dec.permissionDecision, "ask")
})

// --- runCommandHandler (real spawns) ----------------------------------------

test("runCommandHandler: exit 2 blocks with stderr reason", async () => {
  const out = await runCommandHandler(
    nodeCmd("process.stderr.write('denied by policy');process.exit(2)"),
    undefined,
    "{}"
  )
  assert.equal(out.block, "denied by policy")
})

test("runCommandHandler: exit 2 with no output falls back", async () => {
  const out = await runCommandHandler(nodeCmd("process.exit(2)"), undefined, "{}")
  assert.equal(out.block, "hook denied (no message)")
})

test("runCommandHandler: exit 0 JSON decision honoured", async () => {
  const out = await runCommandHandler(
    nodeCmd(
      "process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow',updatedInput:{command:'ls -la'}}}))"
    ),
    undefined,
    "{}"
  )
  assert.deepEqual(out.updatedInput, { command: "ls -la" })
  assert.equal(out.permissionDecision, "allow")
})

test("runCommandHandler: exit 0 plain stdout becomes context", async () => {
  const out = await runCommandHandler(
    nodeCmd("process.stdout.write('hello world')"),
    undefined,
    "{}"
  )
  assert.equal(out.additionalContext, "hello world")
})

test("runCommandHandler: payload is piped to stdin", async () => {
  // Use a temp helper script + shell-quoted path — inline `node -e` quoting is
  // unreliable across cmd.exe / sh for a stdin-reading snippet.
  const helper = join(tmpdir(), "cognia-agent-hooks-echo-stdin.mjs")
  // Prefix so the echoed payload is NOT valid JSON — otherwise it'd be parsed
  // as a decision object instead of landing as additionalContext.
  writeFileSync(
    helper,
    'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>process.stdout.write("stdin:"+d));'
  )
  const out = await runCommandHandler(
    `node ${JSON.stringify(helper)}`,
    undefined,
    JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash" })
  )
  // The echoed payload is plain text (not a decision), so it lands as context.
  assert.match(out.additionalContext, /PreToolUse/)
})

test("runCommandHandler: non-zero/non-2 exit is a soft warning", async () => {
  const out = await runCommandHandler(nodeCmd("process.exit(1)"), undefined, "{}")
  assert.match(out.warning, /code 1/)
})

test("runCommandHandler: timeout kills and soft-allows", async () => {
  const out = await runCommandHandler(nodeCmd("setTimeout(()=>{},10000)"), 1, "{}")
  assert.match(out.warning, /timed out/)
})

test("runCommandHandler: pre-aborted signal warns", async () => {
  const ac = new AbortController()
  ac.abort()
  const out = await runCommandHandler(nodeCmd("setTimeout(()=>{},10000)"), 5, "{}", ac.signal)
  assert.match(out.warning, /aborted/)
})

// --- runWebhookHandler (real local server) ----------------------------------

test("runWebhookHandler: 2xx JSON body parsed, non-2xx warns", async () => {
  const server = http.createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      if (req.url === "/ok") {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ additionalContext: `saw:${body}` }))
      } else {
        res.writeHead(500)
        res.end("boom")
      }
    })
  })
  await new Promise((r) => server.listen(0, r))
  const port = server.address().port
  try {
    const ok = await runWebhookHandler(`http://127.0.0.1:${port}/ok`, {}, 5, '{"x":1}')
    assert.equal(ok.additionalContext, 'saw:{"x":1}')
    const bad = await runWebhookHandler(`http://127.0.0.1:${port}/err`, undefined, 5, "{}")
    assert.match(bad.warning, /500/)
  } finally {
    await new Promise((r) => server.close(r))
  }
})

// --- runGroups --------------------------------------------------------------

test("runGroups: matcher filters, block short-circuits later handlers", async () => {
  const groups = [
    { matcher: "Read", hooks: [{ type: "command", command: nodeCmd("process.exit(2)") }] },
    {
      matcher: "Bash",
      hooks: [
        { type: "command", command: nodeCmd("process.stderr.write('blocked');process.exit(2)") },
        { type: "command", command: nodeCmd("process.stdout.write('should not run')") },
      ],
    },
  ]
  const dec = await runGroups(groups, "Bash", "{}")
  assert.equal(dec.block, "blocked")
  // The second handler (context) must not have run.
  assert.equal(dec.additionalContext, undefined)
})

test("runGroups: unknown handler types are inert", async () => {
  const dec = await runGroups(
    [{ hooks: [{ type: "prompt", prompt: "x" }, { type: "mystery" }] }],
    "Bash",
    "{}"
  )
  assert.equal(dec.block, undefined)
  assert.equal(dec.warnings.length, 0)
})

// --- mapDecisionToOutput ----------------------------------------------------

test("mapDecisionToOutput: PreToolUse deny / rewrite / ask / context / noop", () => {
  assert.deepEqual(mapDecisionToOutput("PreToolUse", { block: "no", warnings: [] }), {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "no",
    },
  })
  assert.deepEqual(
    mapDecisionToOutput("PreToolUse", { updatedInput: { command: "ls" }, warnings: [] }),
    {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: { command: "ls" },
      },
    }
  )
  assert.equal(
    mapDecisionToOutput("PreToolUse", { permissionDecision: "ask", warnings: [] })
      .hookSpecificOutput.permissionDecision,
    "ask"
  )
  assert.equal(
    mapDecisionToOutput("PreToolUse", { additionalContext: "c", warnings: [] }).hookSpecificOutput
      .additionalContext,
    "c"
  )
  assert.deepEqual(mapDecisionToOutput("PreToolUse", { warnings: ["w"] }), {})
})

test("mapDecisionToOutput: PostToolUse output rewrite + block", () => {
  assert.deepEqual(
    mapDecisionToOutput("PostToolUse", { updatedToolOutput: "patched", warnings: [] }),
    { hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: "patched" } }
  )
  assert.deepEqual(mapDecisionToOutput("PostToolUse", { block: "bad", warnings: [] }), {
    decision: "block",
    reason: "bad",
  })
  assert.equal(
    mapDecisionToOutput("PostToolUseFailure", { additionalContext: "c", warnings: [] })
      .hookSpecificOutput.hookEventName,
    "PostToolUseFailure"
  )
})

test("mapDecisionToOutput: generic lifecycle block + context", () => {
  assert.deepEqual(mapDecisionToOutput("Stop", { block: "keep going", warnings: [] }), {
    decision: "block",
    reason: "keep going",
  })
  assert.equal(
    mapDecisionToOutput("SessionStart", { additionalContext: "ctx", warnings: [] })
      .hookSpecificOutput.additionalContext,
    "ctx"
  )
})

// --- hook_fire projection ---------------------------------------------------

test("hookFireOutcome: precedence block > context > warning > null", () => {
  assert.equal(hookFireOutcome({ block: "x", warnings: [] }), "blocked")
  assert.equal(hookFireOutcome({ additionalContext: "x", warnings: [] }), "context")
  assert.equal(hookFireOutcome({ warnings: ["w"] }), "warning")
  assert.equal(hookFireOutcome({ warnings: [] }), null)
})

test("buildHookFirePayload: matches the Rust envelope shape, null on no-op", () => {
  assert.equal(buildHookFirePayload("s1", "Stop", null, { warnings: [] }), null)
  const p = buildHookFirePayload("s1", "PreToolUse", "Bash", {
    block: "no",
    warnings: ["w"],
  })
  assert.equal(p.type, "event")
  assert.equal(p.sessionId, "s1")
  assert.equal(p.event.subtype, "hook_fire")
  assert.equal(p.event.hook_event, "PreToolUse")
  assert.equal(p.event.tool_name, "Bash")
  assert.equal(p.event.outcome, "blocked")
  assert.equal(p.event.block, "no")
  assert.deepEqual(p.event.warnings, ["w"])
})

// --- buildAgentHooks / mergeHookMaps ----------------------------------------

test("buildAgentHooks: only registers events with configured groups", () => {
  assert.equal(buildAgentHooks(undefined, {}), undefined)
  assert.equal(buildAgentHooks({}, {}), undefined)
  const map = buildAgentHooks(
    { PreToolUse: [{ hooks: [{ type: "command", command: "echo" }] }], Stop: [{ hooks: [] }] },
    { sessionId: "s", emit() {} }
  )
  assert.deepEqual(Object.keys(map), ["PreToolUse"])
  assert.equal(typeof map.PreToolUse[0].hooks[0], "function")
})

test("buildAgentHooks: callback runs handlers, emits hook_fire, returns mapped output", async () => {
  const emitted = []
  const map = buildAgentHooks(
    {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [
            {
              type: "command",
              command: nodeCmd("process.stderr.write('nope');process.exit(2)"),
            },
          ],
        },
      ],
    },
    { sessionId: "sess", emit: (m) => emitted.push(m) }
  )
  const cb = map.PreToolUse[0].hooks[0]
  const out = await cb(
    { hook_event_name: "PreToolUse", session_id: "sess", tool_name: "Bash", tool_input: {} },
    "tu1",
    { signal: undefined }
  )
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny")
  assert.equal(out.hookSpecificOutput.permissionDecisionReason, "nope")
  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].event.subtype, "hook_fire")
  assert.equal(emitted[0].event.outcome, "blocked")
})

test("buildAgentHooks: callback no-ops (no emit) when a non-matching tool", async () => {
  const emitted = []
  const map = buildAgentHooks(
    {
      PreToolUse: [
        { matcher: "Read", hooks: [{ type: "command", command: nodeCmd("process.exit(2)") }] },
      ],
    },
    { sessionId: "s", emit: (m) => emitted.push(m) }
  )
  const out = await map.PreToolUse[0].hooks[0]({ tool_name: "Bash" }, "t", {})
  assert.deepEqual(out, {})
  assert.equal(emitted.length, 0)
})

test("mergeHookMaps: concatenates arrays per event, skips undefined, undefined when empty", () => {
  assert.equal(mergeHookMaps(undefined, null), undefined)
  const lsp = { PostToolUse: [{ hooks: ["lsp"] }] }
  const agent = { PostToolUse: [{ hooks: ["agent"] }], PreToolUse: [{ hooks: ["pre"] }] }
  const merged = mergeHookMaps(lsp, agent)
  assert.equal(merged.PostToolUse.length, 2)
  assert.equal(merged.PreToolUse.length, 1)
})
