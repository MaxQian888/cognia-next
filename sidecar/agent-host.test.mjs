// Agent host additions (ADR-0090 Phase 3): command idempotency, capability
// gating, and the claude-host.mjs compatibility shim. Lifecycle behavior
// (makeWrappedEmit / restartReason / routeClose …) stays covered by
// claude-host.test.mjs, which now imports through the shim — passing there IS
// the compat proof.

import test from "node:test"
import assert from "node:assert/strict"

import {
  blockUnsupportedCommand,
  buildPermissionResult,
  controlPreflight,
  dropDuplicateCommand,
  envelopeEmitterParams,
  persistableSuggestions,
  providerVisibleSendPayloadIsSafe,
  startAgentHost,
  routeSetMode,
  emitObservers,
  emitForTests,
  smokeCredentialGap,
  smokeObserveFrame,
  smokeOutcome,
} from "./agent-host.mjs"
import * as shim from "./claude-host.mjs"

test("the claude-host shim re-exports the full agent-host surface", () => {
  for (const name of [
    "makeWrappedEmit",
    "restartReason",
    "routeClose",
    "routeRestore",
    "routeSteer",
    "buildPermissionResult",
    "startAgentHost",
    "dropDuplicateCommand",
    "blockUnsupportedCommand",
  ]) {
    assert.equal(typeof shim[name], "function", `shim must re-export ${name}`)
  }
  assert.equal(shim.startAgentHost, startAgentHost, "same function object, not a copy")
})

test("duplicate commandIds are acked once and dropped; LRU caps at 128", () => {
  const sessions = new Map([["s1", {}]])
  const out = []
  const emit = (m) => out.push(m)

  assert.equal(dropDuplicateCommand(sessions, { sessionId: "s1", commandId: "c1" }, emit), false)
  assert.equal(dropDuplicateCommand(sessions, { sessionId: "s1", commandId: "c1" }, emit), true)
  assert.deepEqual(out, [
    { type: "command_ack", sessionId: "s1", commandId: "c1", duplicate: true },
  ])

  // Fill past the LRU cap: the oldest id ages out and is processable again.
  for (let i = 0; i < 130; i += 1) {
    dropDuplicateCommand(sessions, { sessionId: "s1", commandId: `fill-${i}` }, emit)
  }
  assert.equal(dropDuplicateCommand(sessions, { sessionId: "s1", commandId: "c1" }, emit), false)

  // Messages without ids, or for unknown sessions, are never dropped.
  assert.equal(dropDuplicateCommand(sessions, { sessionId: "s1" }, emit), false)
  assert.equal(dropDuplicateCommand(sessions, { sessionId: "ghost", commandId: "x" }, emit), false)
})

test("commands unsupported by the frozen adapter emit a typed capability_error", () => {
  const sessions = new Map([
    ["frozen", { runtimeAdapterId: "ai-sdk" }],
    ["legacy", {}],
  ])
  const out = []
  const emit = (m) => out.push(m)

  // ai-sdk supports compaction/set_mode; steer is unsupported on both rails.
  assert.equal(
    blockUnsupportedCommand(sessions, { sessionId: "frozen", type: "steer" }, emit),
    true
  )
  assert.deepEqual(out, [
    { type: "capability_error", sessionId: "frozen", capability: "steer", command: "steer" },
  ])
  assert.equal(
    blockUnsupportedCommand(sessions, { sessionId: "frozen", type: "compact" }, emit),
    false
  )
  // Legacy sessions and unknown sessions are never blocked.
  assert.equal(
    blockUnsupportedCommand(sessions, { sessionId: "legacy", type: "steer" }, emit),
    false
  )
  assert.equal(
    blockUnsupportedCommand(sessions, { sessionId: "ghost", type: "steer" }, emit),
    false
  )
})

test("startAgentHost is exported and idempotent by contract (guard flag)", () => {
  // We cannot start the real stdin loop in a test process; assert the export
  // exists and is a zero-arg function (the shim + packaged-CLI role rely on
  // calling it more than once safely — see the hostStarted guard).
  assert.equal(typeof startAgentHost, "function")
  assert.equal(startAgentHost.length, 0)
})

test("provider-visible sends are rejected when any prompt surface leaks PII", () => {
  assert.equal(
    providerVisibleSendPayloadIsSafe({
      prompt: "summarize this",
      options: { systemPrompt: "be concise", appendSystemPrompt: "use bullets" },
    }),
    true
  )
  assert.equal(
    providerVisibleSendPayloadIsSafe({
      prompt: "email alice@example.com",
      options: { systemPrompt: "be concise" },
    }),
    false
  )
  assert.equal(
    providerVisibleSendPayloadIsSafe({
      prompt: "summarize this",
      options: { appendSystemPrompt: "token sk-proj-abc123def456ghi789jkl012" },
    }),
    false
  )
  assert.equal(
    providerVisibleSendPayloadIsSafe({
      prompt: "summarize this",
      options: {
        claudeAgentSdk: {
          version: 1,
          planModeInstructions: "send the plan to alice@example.com",
        },
      },
    }),
    false
  )
  assert.equal(
    providerVisibleSendPayloadIsSafe({
      prompt: "summarize this",
      options: {
        agents: { reviewer: { initialPrompt: "contact alice@example.com" } },
      },
    }),
    false
  )
})

// ---- permission result: user intent that used to be discarded --------------

const ALLOW_RULE = { type: "addRules", rules: [{ toolName: "Bash" }], destination: "session" }

test("the legacy rail's permission result is unchanged, field for field", () => {
  // ADR-0090 constraint 6: `claude_send` is still the production queue and this
  // is the same function on both rails, so the richer fields must be invisible
  // to it — an extra key here is a behaviour change on a path nobody opted in.
  assert.deepEqual(buildPermissionResult("allow", { input: { a: 1 } }), {
    behavior: "allow",
    updatedInput: { a: 1 },
  })
  assert.deepEqual(
    buildPermissionResult("allow_always", { input: { a: 1 }, suggestions: [ALLOW_RULE] }),
    { behavior: "allow", updatedInput: { a: 1 } }
  )
  assert.deepEqual(buildPermissionResult("deny", { message: "no", interrupt: true }), {
    behavior: "deny",
    message: "no",
  })
})

test('"always allow" carries the SDK\'s own permission updates on the new rail', () => {
  // Without this the user's "always" held for the renderer's session only: the
  // CLI's rule store never learned the decision, so the next identical call
  // prompted again.
  const res = buildPermissionResult("allow_always", {
    input: { a: 1 },
    suggestions: [ALLOW_RULE],
    rich: true,
  })
  assert.deepEqual(res.updatedPermissions, [ALLOW_RULE])
  assert.equal(res.decisionClassification, "user_permanent")
})

test("a one-off allow classifies as temporary and persists nothing", () => {
  const res = buildPermissionResult("allow", {
    input: {},
    suggestions: [ALLOW_RULE],
    rich: true,
  })
  assert.equal(res.decisionClassification, "user_temporary")
  assert.equal(res.updatedPermissions, undefined)
})

test("a deny can interrupt the turn instead of letting the model route around it", () => {
  const res = buildPermissionResult("deny", { message: "nope", interrupt: true, rich: true })
  assert.deepEqual(res, {
    behavior: "deny",
    message: "nope",
    interrupt: true,
    decisionClassification: "user_reject",
  })
  // Absent unless asked for — a plain refusal should not end the turn.
  assert.equal(buildPermissionResult("deny", { rich: true }).interrupt, undefined)
})

test("localSettings suggestions are never written back from a chat click", () => {
  // Those edit the user's on-disk settings file. Approving a tool call is
  // consent for this session, not consent to rewrite their configuration.
  const kept = persistableSuggestions([
    ALLOW_RULE,
    { type: "addRules", rules: [], destination: "localSettings" },
    { type: "setMode", mode: "acceptEdits", destination: "userSettings" },
  ])
  assert.deepEqual(kept, [
    ALLOW_RULE,
    { type: "setMode", mode: "acceptEdits", destination: "userSettings" },
  ])
})

test("malformed suggestions are dropped rather than forwarded as rules", () => {
  assert.deepEqual(persistableSuggestions(undefined), [])
  assert.deepEqual(persistableSuggestions("nope"), [])
  assert.deepEqual(
    persistableSuggestions([null, {}, { type: "addRules" }, { destination: "session" }]),
    []
  )
})

// ---- envelope emitter configuration ------------------------------------------

const emitterFor = (sendOptions) =>
  envelopeEmitterParams({
    sessionId: "s1",
    sendOptions,
    turnRef: { id: "t1" },
    emit: () => {},
  })

test("a session without a frozen spec gets no envelope emitter at all", () => {
  // ADR-0090: envelope emission is additive and only for spec-carrying
  // sessions. Returning params here would put the legacy queue on a second
  // channel it never asked for.
  assert.equal(emitterFor({}), null)
  assert.equal(emitterFor(undefined), null)
})

test("emitter identity falls back to the session id rather than inventing one", () => {
  const params = emitterFor({ execution: { runtimeAdapter: "claude-agent-sdk" } })
  assert.equal(params.runId, "s1")
  assert.equal(params.attemptId, "a1")
  assert.equal(params.hostRef, "desktop-sidecar")
  assert.equal(params.parentRunId, undefined)
})

test("explicit execution identity wins over every fallback", () => {
  const params = emitterFor({
    execution: {
      runtimeAdapter: "claude-agent-sdk",
      hostRef: "companion",
      identity: { runId: "r9", attemptId: "a3", parentRunId: "r1" },
    },
  })
  assert.deepEqual(
    { runId: params.runId, attemptId: params.attemptId, parentRunId: params.parentRunId },
    { runId: "r9", attemptId: "a3", parentRunId: "r1" }
  )
  assert.equal(params.hostRef, "companion")
})

test("the structured-output expectation is derived from the send, not defaulted on", () => {
  // If this ever silently returns true, every ordinary turn of a spec-carrying
  // session settles as `structured_output_missing`.
  assert.equal(emitterFor({ execution: { runtimeAdapter: "x" } }).expectStructuredOutput, false)
  assert.equal(
    emitterFor({
      execution: { runtimeAdapter: "x" },
      claudeAgentSdk: { version: 1, outputFormat: { type: "json_schema", schema: {} } },
    }).expectStructuredOutput,
    true
  )
})

// ---- control frame preflight -------------------------------------------------

test("an unallowlisted method is refused before anything else is considered", () => {
  assert.deepEqual(controlPreflight("claude-agent-sdk", "close", {}), { error: "unknown_method" })
  assert.deepEqual(controlPreflight(undefined, "__proto__", {}), { error: "unknown_method" })
})

test("a control the frozen adapter cannot serve returns a typed capability miss", () => {
  // ai-sdk has no `Query` object, so every SDK control is unservable there.
  // Before this the caller got `unsupported_provider`, which says nothing
  // about WHICH capability was missing.
  assert.deepEqual(controlPreflight("ai-sdk", "reloadPlugins", {}), {
    error: "capability_error",
    capability: "plugins.native",
  })
  assert.equal(controlPreflight("claude-agent-sdk", "reloadPlugins", {}), null)
})

test("a legacy session (no frozen adapter) is never capability-gated", () => {
  // ADR-0090 constraint 6: the flag-off queue keeps today's behaviour, where a
  // method the runtime lacks surfaces as `unsupported_provider` downstream.
  assert.equal(controlPreflight(undefined, "reloadPlugins", {}), null)
})

test("an unknown adapter id is permissive rather than fail-closed", () => {
  // Failing closed here would reject every control on a session whose adapter
  // this build simply cannot read — a newer host talking to an older sidecar.
  assert.equal(controlPreflight("runtime-from-the-future", "reloadPlugins", {}), null)
})

test("params are validated after the capability, so the error names the real problem", () => {
  // Both are wrong here. Reporting `invalid_task_id` would send the caller
  // fixing a payload for a rail that could never run the control anyway.
  assert.deepEqual(controlPreflight("ai-sdk", "stopTask", {}), {
    error: "capability_error",
    capability: "tasks.background",
  })
  assert.deepEqual(controlPreflight("claude-agent-sdk", "stopTask", {}), {
    error: "invalid_task_id",
  })
})

// ---- smoke ------------------------------------------------------------------

test("smokeCredentialGap names every accepted variable when none is set", () => {
  assert.deepEqual(smokeCredentialGap({}), [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
  ])
  assert.equal(
    smokeCredentialGap({ ANTHROPIC_API_KEY: "" }),
    null === null ? smokeCredentialGap({ ANTHROPIC_API_KEY: "" }) : null
  )
  assert.notEqual(
    smokeCredentialGap({ ANTHROPIC_API_KEY: "" }),
    null,
    "an empty value is not a credential"
  )
  assert.equal(smokeCredentialGap({ CLAUDE_CODE_OAUTH_TOKEN: "tok" }), null)
})

test("smokeObserveFrame tracks assistant text and every error shape", () => {
  const state = { sawAssistantText: false, sawError: false, errorReason: null }
  smokeObserveFrame(state, {
    type: "event",
    event: { type: "assistant", message: { content: [{ type: "text", text: "PONG" }] } },
  })
  assert.equal(state.sawAssistantText, true)
  assert.equal(state.sawError, false)

  const errored = { sawAssistantText: false, sawError: false, errorReason: null }
  smokeObserveFrame(errored, {
    type: "session_ended",
    sessionId: "smoke-1",
    error: "401 invalid x-api-key",
  })
  assert.equal(errored.sawError, true)
  assert.match(errored.errorReason, /401/)

  const result = { sawAssistantText: false, sawError: false, errorReason: null }
  smokeObserveFrame(result, {
    type: "event",
    event: { type: "result", is_error: true, subtype: "error_during_execution" },
  })
  assert.equal(result.sawError, true)

  const noise = { sawAssistantText: false, sawError: false, errorReason: null }
  smokeObserveFrame(noise, { type: "log", level: "info", message: "x" })
  smokeObserveFrame(noise, null)
  assert.deepEqual(noise, { sawAssistantText: false, sawError: false, errorReason: null })
})

test("smokeOutcome exit codes: 0 only for text without error, 1 error, 3 timeout", () => {
  assert.equal(smokeOutcome({ sawAssistantText: true, sawError: false }).code, 0)
  assert.equal(
    smokeOutcome({ sawAssistantText: true, sawError: true, errorReason: "boom" }).code,
    1
  )
  assert.equal(
    smokeOutcome({ sawAssistantText: false, sawError: false, timedOut: true, timeoutMs: 5 }).code,
    3
  )
  assert.equal(smokeOutcome({ sawAssistantText: false, sawError: false }).code, 1)
})

test("emitObservers see every frame and cannot break the wire", () => {
  const seen = []
  const observer = (payload) => seen.push(payload.type)
  const thrower = () => {
    throw new Error("observer bug")
  }
  emitObservers.add(observer)
  emitObservers.add(thrower)
  try {
    const originalWrite = process.stdout.write
    process.stdout.write = () => true
    try {
      emitForTests({ type: "log", level: "info", message: "hi" })
    } finally {
      process.stdout.write = originalWrite
    }
  } finally {
    emitObservers.delete(observer)
    emitObservers.delete(thrower)
  }
  assert.deepEqual(seen, ["log"])
})

test("mode switches commit only after SDK acknowledgement and preserve mode on rejection", async () => {
  let acknowledge
  const pending = new Promise((resolve) => {
    acknowledge = resolve
  })
  const session = {
    sendOptions: { provider: "anthropic", permissionMode: "default" },
    q: { setPermissionMode: () => pending },
  }
  const sessions = new Map([["s", session]])
  const switching = routeSetMode(sessions, { sessionId: "s", mode: "plan" })
  assert.equal(session.sendOptions.permissionMode, "default")
  acknowledge()
  assert.deepEqual(await switching, { ok: true, result: { mode: "plan" } })
  assert.equal(session.sendOptions.permissionMode, "plan")
  session.q.setPermissionMode = async () => {
    throw new Error("SDK refused")
  }
  assert.deepEqual(await routeSetMode(sessions, { sessionId: "s", mode: "acceptEdits" }), {
    ok: false,
    error: "SDK refused",
  })
  assert.equal(session.sendOptions.permissionMode, "plan")
})
test("AI SDK mode acknowledgement commits locally; stale/missing sessions cannot acknowledge", async () => {
  const session = { sendOptions: { provider: "deepseek", permissionMode: "default" } }
  const sessions = new Map([["s", session]])
  assert.deepEqual(await routeSetMode(sessions, { sessionId: "s", mode: "auto" }), {
    ok: true,
    result: { mode: "auto" },
  })
  assert.equal(session.sendOptions.permissionMode, "auto")
  assert.deepEqual(await routeSetMode(sessions, { sessionId: "missing", mode: "plan" }), {
    ok: false,
    error: "no_active_session",
  })
})

test("timed-out mode transition retires the uncertain SDK before it can apply later", async () => {
  let acknowledge
  let closed = false
  const session = {
    sendOptions: { provider: "anthropic", permissionMode: "default" },
    closeInput() {
      closed = true
    },
    q: {
      close() {},
      setPermissionMode: () =>
        new Promise((resolve) => {
          acknowledge = resolve
        }),
    },
  }
  const sessions = new Map([["s", session]])
  assert.deepEqual(await routeSetMode(sessions, { sessionId: "s", mode: "plan" }, 5), {
    ok: false,
    error: "control timed out",
  })
  assert.equal(closed, true)
  assert.equal(sessions.has("s"), false)
  acknowledge()
  await Promise.resolve()
  assert.equal(session.sendOptions.permissionMode, "default")
})

test(
  "stdio live AI SDK session applies acknowledged Plan, approval, cancellation and elicitation controls",
  { timeout: 60_000 },
  async () => {
    const { spawn } = await import("node:child_process")
    const { createServer } = await import("node:http")
    const fs = await import("node:fs/promises")
    const os = await import("node:os")
    const path = await import("node:path")
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "cognia-live-controls-"))
    const requests = []
    const server = createServer(async (req, res) => {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString())
      requests.push(body)
      const lastUser = body.messages.findLastIndex((message) => message.role === "user")
      const prompt = String(body.messages[lastUser]?.content)
      const done = body.messages.slice(lastUser + 1).some((message) => message.role === "tool")
      const tool =
        prompt === "background"
          ? "start_process"
          : prompt === "question"
            ? "ask_user"
            : prompt === "read"
              ? "read"
              : "write"
      const input =
        tool === "start_process"
          ? { program: "node", args: ["--version"], detached: true, cwd: workspace }
          : tool === "ask_user"
            ? { question: "Which target?" }
            : tool === "read"
              ? { file_path: path.join(workspace, "allowed.txt") }
              : { file_path: path.join(workspace, prompt + ".txt"), content: prompt }
      res.writeHead(200, { "content-type": "text/event-stream" })
      const emit = (delta, finish_reason = null) =>
        res.write(
          `data: ${JSON.stringify({ id: "scripted-control", object: "chat.completion.chunk", created: 1, model: "scripted", choices: [{ index: 0, delta, finish_reason }] })}\n\n`
        )
      if (done) emit({ content: "CONTROL_TURN_DONE" }, "stop")
      else
        emit(
          {
            tool_calls: [
              {
                index: 0,
                id: "call-" + requests.length,
                type: "function",
                function: { name: tool, arguments: JSON.stringify(input) },
              },
            ],
          },
          "tool_calls"
        )
      res.end("data: [DONE]\n\n")
    })
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
    const child = spawn(process.execPath, [new URL("./agent-host.mjs", import.meta.url).pathname], {
      stdio: ["pipe", "pipe", "pipe"],
    })
    let buffer = ""
    let stderr = ""
    const frames = []
    child.stderr.on("data", (chunk) => {
      stderr += chunk
    })
    child.stdout.on("data", (chunk) => {
      buffer += chunk
      for (;;) {
        const end = buffer.indexOf("\n")
        if (end < 0) break
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        try {
          frames.push(JSON.parse(line))
        } catch {
          /* ignore non-protocol SDK diagnostics */
        }
      }
    })
    const send = (message) =>
      child.stdin.write(JSON.stringify({ sessionId: "live-controls", ...message }) + "\n")
    const wait = async (predicate, start = 0) => {
      const deadline = Date.now() + 12_000
      while (Date.now() < deadline) {
        const frame = frames.slice(start).find(predicate)
        if (frame) return frame
        if (child.exitCode !== null) throw new Error(`sidecar exited: ${stderr}`)
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      throw new Error(`frame timeout: ${JSON.stringify(frames.slice(start))} ${stderr}`)
    }
    const options = {
      provider: "openai",
      model: "scripted",
      cwd: workspace,
      permissionMode: "acceptEdits",
      builtinTools: { coreFiles: true, process: true },
      backgroundProcessHost: "sidecar",
      providerCredentials: {
        apiKey: "fixture",
        protocol: "openai",
        baseURL: `http://127.0.0.1:${server.address().port}/v1`,
      },
      pluginTools: [
        {
          name: "ask_user",
          pluginId: "human",
          description: "Ask user",
          jsonSchema: {
            type: "object",
            properties: { question: { type: "string" } },
            required: ["question"],
          },
        },
      ],
    }
    const turn = async (prompt, respond) => {
      const start = frames.length
      send({ type: "send", prompt, options })
      if (respond) await respond(start)
      const ended = await wait((frame) => frame.type === "session_ended", start)
      assert.equal(ended.error, undefined)
      return frames.slice(start)
    }
    let controlId = 0
    const mode = async (value) => {
      const requestId = "mode-" + ++controlId
      send({ type: "control", requestId, method: "setPermissionMode", params: { mode: value } })
      return wait((frame) => frame.type === "control_response" && frame.requestId === requestId)
    }
    try {
      await turn("allowed")
      assert.equal(await fs.readFile(path.join(workspace, "allowed.txt"), "utf8"), "allowed")
      assert.equal((await mode("plan")).ok, true)
      await turn("blocked")
      await assert.rejects(fs.stat(path.join(workspace, "blocked.txt")), { code: "ENOENT" })
      await turn("read")
      assert.match(JSON.stringify(requests.at(-1).messages), /allowed/)
      assert.equal((await mode("invalid-mode")).ok, false)
      await turn("still-blocked")
      await assert.rejects(fs.stat(path.join(workspace, "still-blocked.txt")), { code: "ENOENT" })
      await turn("question", async (start) => {
        const question = await wait((frame) => frame.type === "plugin_tool_exec", start)
        assert.equal(question.name, "ask_user")
        send({ type: "plugin_tool_response", toolUseId: question.toolUseId, result: "workspace" })
      })
      assert.equal((await mode("default")).ok, true)
      for (const decision of ["allow", "deny"]) {
        await turn(decision, async (start) => {
          const approval = await wait((frame) => frame.type === "permission_request", start)
          send({ type: "permission_response", requestId: approval.requestId, decision })
        })
      }
      assert.equal(await fs.readFile(path.join(workspace, "allow.txt"), "utf8"), "allow")
      await assert.rejects(fs.stat(path.join(workspace, "deny.txt")), { code: "ENOENT" })
      let stale
      await turn("cancel", async (start) => {
        stale = await wait((frame) => frame.type === "permission_request", start)
        send({ type: "interrupt" })
      })
      send({ type: "permission_response", requestId: stale.requestId, decision: "allow" })
      await turn("after-cancel", async (start) => {
        const approval = await wait((frame) => frame.type === "permission_request", start)
        assert.notEqual(approval.requestId, stale.requestId)
        send({ type: "permission_response", requestId: approval.requestId, decision: "deny" })
      })
      await assert.rejects(fs.stat(path.join(workspace, "cancel.txt")), { code: "ENOENT" })
      await assert.rejects(fs.stat(path.join(workspace, "after-cancel.txt")), { code: "ENOENT" })
      assert.equal((await mode("acceptEdits")).ok, true)
      await turn("restored")
      assert.equal(await fs.readFile(path.join(workspace, "restored.txt"), "utf8"), "restored")
      assert.equal((await mode("bypassPermissions")).ok, true)
      await turn("background")
      const backgroundResult = requests
        .at(-1)
        .messages.filter((message) => message.role === "tool")
        .at(-1)
      assert.match(JSON.stringify(backgroundResult), /jobId/)
      assert.doesNotMatch(JSON.stringify(backgroundResult), /jobs.spawn.*timed out/)
    } finally {
      child.kill("SIGKILL")
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
      await fs.rm(workspace, { recursive: true, force: true })
    }
  }
)
