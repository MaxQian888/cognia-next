/** Real DeepSeek acceptance. Read {apiKey} on stdin; never persist or print it. */
import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { once } from "node:events"

let input = ""
for await (const bytes of process.stdin) input += bytes
const { apiKey } = JSON.parse(input)
input = ""
assert(typeof apiKey === "string" && apiKey.length > 10, "Provider credential is required on stdin")
const binary = process.env.OMP_BINARY
assert(binary, "Set OMP_BINARY to the official OMP 18.6.1 darwin-arm64 binary")
assert(process.platform === "darwin" && process.arch === "arm64", "This test requires macOS arm64")
assert.equal(
  createHash("sha256")
    .update(await readFile(binary))
    .digest("hex"),
  "b5ca5cd17b8cc09ece36845988fd401f7d1002e1ab5b95600e0f328924246d52"
)
const packageRoot = process.env.OMP_PACKAGE_ROOT ?? fileURLToPath(new URL("../", import.meta.url))
const { OmpRpcClientAdapter } = await import(pathToFileURL(join(packageRoot, "dist/rpc-client.js")))
const { readOmpSession } = await import(pathToFileURL(join(packageRoot, "dist/history.js")))
const extended = process.env.OMP_EXTENDED === "1"
const root = await mkdtemp(join(tmpdir(), "cognia-omp-deepseek-"))
const cwd = join(root, "workspace"),
  home = join(root, "home"),
  agentDir = join(home, ".omp", "agent")
const token = randomUUID(),
  nonce = randomUUID(),
  model = "deepseek-flash"
const sandbox =
  '(version 1)(allow default)(deny network*)(allow network-inbound (local ip "localhost:*"))(allow network-outbound (remote ip "localhost:*"))'
const processes = new Map(),
  outputs = new Set(),
  exits = new Set(),
  pending = new Set()
const requestLog = [],
  checks = [],
  turns = []
const nativeEvents = []
let adapter,
  toolCalls = 0,
  released = 0,
  stderrBytes = 0,
  onRequest
const check = (name) => {
  checks.push(name)
  console.log(JSON.stringify({ check: name, status: "passed" }))
}
const server = createServer(async (req, res) => {
  const abort = new AbortController()
  pending.add(abort)
  res.on("close", () => abort.abort())
  const entry = {
    status: null,
    model: null,
    stream: false,
    thinking: null,
    assistantReasoningMessages: 0,
    reasoningDeltas: 0,
  }
  try {
    assert.equal(req.headers.authorization, `Bearer ${token}`, "Unexpected local caller")
    assert.equal(req.method, "POST")
    assert.equal(req.url, "/v1/chat/completions")
    assert(requestLog.length < (extended ? 32 : 12), "Provider request budget exhausted")
    let body = ""
    for await (const chunk of req) {
      body += chunk
      assert(body.length < 1024 * 1024, "Unexpected request size")
    }
    const payload = JSON.parse(body)
    assert.equal(payload.model, model)
    assert(!body.includes(apiKey), "Credential reached model payload")
    // Keep a finite live-test budget even if the model chooses repeated tool calls.
    assert(
      (payload.max_tokens ?? payload.max_completion_tokens ?? 0) > 0 &&
        (payload.max_tokens ?? payload.max_completion_tokens ?? 0) <= 2048,
      "Unexpected output budget"
    )
    Object.assign(entry, {
      model: payload.model,
      stream: payload.stream,
      thinking: payload.thinking ?? null,
      assistantReasoningMessages: payload.messages.filter(
        (m) =>
          m.role === "assistant" &&
          typeof m.reasoning_content === "string" &&
          m.reasoning_content.length > 0
      ).length,
      images: payload.messages
        .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
        .filter((c) => c.type === "image_url").length,
    })
    requestLog.push(entry)
    const upstream = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body,
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(90000)]),
    })
    entry.status = upstream.status
    onRequest?.(entry, payload)
    res.writeHead(upstream.status, {
      "Content-Type": upstream.headers.get("content-type") ?? "application/json",
    })
    const decoder = new TextDecoder()
    let sse = ""
    for await (const chunk of upstream.body) {
      if (res.destroyed) break
      sse += decoder.decode(chunk, { stream: true })
      let newline
      while ((newline = sse.indexOf("\n")) >= 0) {
        const line = sse.slice(0, newline).trim()
        sse = sse.slice(newline + 1)
        if (line.startsWith("data: ") && line !== "data: [DONE]") {
          const event = JSON.parse(line.slice(6))
          entry.reasoningDeltas +=
            event.choices?.filter((c) => c.delta?.reasoning_content?.length > 0).length ?? 0
        }
      }
      if (!res.write(chunk)) await once(res, "drain", { signal: abort.signal })
    }
    res.end()
  } catch (error) {
    entry.failure = abort.signal.aborted ? "cancelled" : error.name
    if (!res.destroyed) {
      if (!res.headersSent) res.writeHead(502, { "Content-Type": "application/json" })
      res.end(
        JSON.stringify({
          error: { message: String(error.message).replaceAll(apiKey, "[REDACTED]") },
        })
      )
    }
  } finally {
    pending.delete(abort)
  }
})
await new Promise((resolve, reject) => {
  server.once("error", reject)
  server.listen(0, "127.0.0.1", resolve)
})
try {
  await Promise.all([
    mkdir(cwd, { recursive: true }),
    mkdir(agentDir, { recursive: true }),
    mkdir(join(root, "tmp")),
  ])
  await writeFile(
    join(agentDir, "models.yml"),
    JSON.stringify({
      providers: {
        deepseek: {
          baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
          apiKey: "OMP_TEST_TOKEN",
          modelOverrides: { [model]: { maxTokens: 2048 } },
        },
      },
    })
  )
  await writeFile(
    join(agentDir, "config.yml"),
    JSON.stringify({
      models: {
        default: `deepseek/${model}`,
        smol: `deepseek/${model}`,
        slow: `deepseek/${model}`,
      },
      compaction: {
        enabled: false,
        ...(extended ? { reserveTokens: 2048, keepRecentTokens: 128 } : {}),
      },
      retry: { enabled: false },
    })
  )
  const extension = join(root, "guard.mjs")
  await writeFile(
    extension,
    `import {createOmpNativeGuard} from ${JSON.stringify(join(packageRoot, "dist/native-guard.js"))};
export default api=>createOmpNativeGuard({nonce:${JSON.stringify(nonce)},enforcement:{isolatedExtensions:true,providerEgressControlled:true,rebindingVerified:true},authorize:async request=>({allow:['test_sum',${extended ? "'task','yield'" : ""}].includes(request.toolName)}),redactResult:async value=>value,transformOutbound:value=>value,terminate:()=>process.exit(91)})(api);
`
  )
  const subscribe = (set) => async (listener) => {
    set.add(listener)
    return () => set.delete(listener)
  }
  const processHost = {
    available: true,
    commandExists: async () => true,
    onStdoutRaw: subscribe(outputs),
    onExit: subscribe(exits),
    onStdoutLine: async () => () => {},
    onStderr: async () => () => {},
    spawn: async (spec) => {
      const child = spawn(
        "/usr/bin/sandbox-exec",
        [
          "-p",
          sandbox,
          spec.command,
          ...spec.args,
          "--no-skills",
          "--no-rules",
          "--no-lsp",
          "--no-title",
          "--no-prewalk",
          ...(extended ? ["--tools", "task"] : ["--no-tools"]),
          "--provider",
          "deepseek",
          "--model",
          model,
          "--system-prompt",
          "You are running a synthetic integration test. Follow the user request exactly. Be concise. Use explicitly requested test tools.",
        ],
        { cwd: spec.cwd, env: spec.env, stdio: ["pipe", "pipe", "pipe"] }
      )
      processes.set(spec.id, child)
      child.stdout.on("data", (data) => {
        for (const listener of outputs)
          listener({ processId: spec.id, data: data.toString("base64") })
      })
      child.stderr.on("data", (data) => {
        stderrBytes += data.byteLength
      })
      child.on("exit", (code) => {
        processes.delete(spec.id)
        for (const listener of exits) listener({ processId: spec.id, code })
      })
      await once(child, "spawn")
      return spec.id
    },
    send: async (id, line) => {
      const child = processes.get(id)
      assert(child)
      await new Promise((resolve, reject) =>
        child.stdin.write(line, (error) => (error ? reject(error) : resolve()))
      )
    },
    kill: async (id) => {
      const child = processes.get(id)
      if (!child) return
      const exited = once(child, "exit")
      child.kill("SIGTERM")
      const timer = setTimeout(() => child.kill("SIGKILL"), 2000)
      try {
        await exited
      } finally {
        clearTimeout(timer)
      }
    },
  }
  adapter = new OmpRpcClientAdapter({
    processHost,
    outboundGate: (payload) => !JSON.stringify(payload).includes(apiKey),
    probeRuntime: async () => ({ command: binary, version: "18.6.1" }),
    prepareSession: async () => ({
      cwd,
      sessionDir: join(root, "sessions"),
      trustedExtensionPath: extension,
      nonce,
      env: {
        HOME: home,
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        TMPDIR: join(root, "tmp"),
        PI_CODING_AGENT_DIR: agentDir,
        OMP_PROFILE: "",
        OMP_TEST_TOKEN: token,
        TERM: "dumb",
        NO_COLOR: "1",
      },
      enforcement: {
        isolatedExtensions: true,
        providerEgressControlled: true,
        rebindingVerified: true,
      },
      release: async () => {
        released++
      },
    }),
    hostTool: async (request, signal) => {
      assert(!signal.aborted)
      assert.equal(request.toolName, "test_sum")
      assert.equal(request.arguments.a, 19)
      assert.equal(request.arguments.b, 23)
      toolCalls++
      return { content: [{ type: "text", text: "42" }] }
    },
    timeoutMs: extended ? 120000 : 30000,
    promptTimeoutMs: 120000,
    onNativeEvent: (_id, event) => {
      if (event.type === "subagent_lifecycle" || event.type === "subagent_event")
        nativeEvents.push(event)
    },
  })
  await adapter.connect({
    id: "deepseek-live",
    name: "OMP DeepSeek live",
    protocol: "omp-rpc",
    transport: "stdio",
    enabled: true,
  })
  let session = await adapter.createSession()
  const models = await adapter.getSessionModels(session.id)
  assert.equal(models.currentModelId, `deepseek/${model}`)
  check("native-deepseek-model-selected")
  const run = async (label, text, images = []) => {
    const started = Date.now(),
      events = []
    for await (const event of adapter.prompt(session.id, {
      id: randomUUID(),
      role: "user",
      timestamp: new Date(),
      content: [{ type: "text", text }, ...images],
    }))
      events.push(event)
    const done = events.find((e) => e.type === "done")
    const errors = events.filter((e) => e.type === "error").map((e) => e.error)
    assert(done?.success, `Turn ${label} failed: ${errors.join("; ")}`)
    assert(!errors.length, `Turn ${label} emitted errors: ${errors.join("; ")}`)
    const output = events
      .filter((e) => e.type === "message_delta" && e.delta.type === "text")
      .map((e) => e.delta.text)
      .join("")
    const summary = {
      label,
      elapsedMs: Date.now() - started,
      textDeltas: events.filter((e) => e.type === "message_delta" && e.delta.type === "text")
        .length,
      thinkingDeltas: events.filter(
        (e) => e.type === "message_delta" && e.delta.type === "thinking"
      ).length,
      toolEvents: events.filter((e) => e.type === "tool_result").length,
      usage: done.tokenUsage,
    }
    assert(summary.usage?.totalTokens > 0, "Missing actual provider usage")
    turns.push(summary)
    console.log(JSON.stringify({ turn: summary }))
    return output
  }
  await adapter.getOmpSession(session.id).setThinkingLevel({ level: "off" })
  assert.match(
    await run("stream", "Remember the synthetic code COBALT-731. Reply with exactly READY-731."),
    /READY-731/
  )
  check("real-stream-and-usage")
  assert.match(
    await run(
      "multi-turn",
      "What synthetic code did I ask you to remember? Reply with the code only."
    ),
    /COBALT-731/
  )
  check("multi-turn-context")
  await adapter.getOmpSession(session.id).setThinkingLevel({ level: "high" })
  await adapter.getOmpSession(session.id).setHostTools({
    tools: [
      {
        name: "test_sum",
        description: "Add the two supplied test integers. Use this tool when requested.",
        parameters: {
          type: "object",
          properties: { a: { type: "integer" }, b: { type: "integer" } },
          required: ["a", "b"],
          additionalProperties: false,
        },
      },
    ],
  })
  assert.match(
    await run(
      "thinking-tool",
      "Find the two positive integers a and b satisfying a+b=42 and b-a=4. Call test_sum with those two integers exactly once. Do not use other tools. After receiving its result, reply with the result only."
    ),
    /42/
  )
  assert.equal(toolCalls, 1)
  assert(
    turns.at(-1).thinkingDeltas > 0,
    `No reasoning stream observed (provider emitted ${requestLog.reduce((n, r) => n + r.reasoningDeltas, 0)} reasoning deltas)`
  )
  check("thinking-and-host-tool-roundtrip")
  assert.match(
    await run(
      "reasoning-continuation",
      "Without tools, repeat the synthetic code I originally supplied. Code only."
    ),
    /COBALT-731/
  )
  assert(
    requestLog.some((r) => r.assistantReasoningMessages > 0),
    "No reasoning content carried to subsequent provider calls"
  )
  check("reasoning-preserved-across-tool-and-user-turns")
  const sourceId = session.id,
    sourceNative = session.metadata.nativeSessionId
  session = await adapter.forkSession(sourceId)
  assert.notEqual(session.metadata.nativeSessionId, sourceNative)
  await adapter.closeSession(sourceId)
  assert.match(
    await run("fork-context", "Repeat the synthetic code from our prior conversation. Code only."),
    /COBALT-731/
  )
  check("native-fork-context")
  await adapter.closeSession(session.id)
  session = await adapter.resumeSession(session.id)
  await adapter.getOmpSession(session.id).setThinkingLevel({ level: "off" })
  assert.match(
    await run(
      "resume-context",
      "Repeat the synthetic code from our prior conversation. Code only."
    ),
    /COBALT-731/
  )
  check("native-resume-context")
  if (extended) {
    const client = adapter.getOmpSession(session.id)
    // A deterministic 64x64 solid-red PNG fixture, generated without external assets.
    const redPng =
      "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAb0lEQVR4nO3PAQkAAAyEwO9feoshgnABdLep8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3IPanc8OLDQitxAAAAAElFTkSuQmCC"
    assert.match(
      await run(
        "image-input",
        "What is the dominant color of the attached image? Reply with one uppercase English color name.",
        [{ type: "image", source: { type: "base64", mediaType: "image/png", data: redPng } }]
      ),
      /RED/
    )
    assert(requestLog.at(-1).images > 0, "Image was not forwarded to the provider")
    check("real-image-input")
    const beforeHandoff = (await client.getEntries()).entries.length
    const handoff = await client.handoff({
      customInstructions:
        "Keep the synthetic code COBALT-731 and the tool result 42. Summarize briefly.",
    })
    assert(handoff !== null, "Handoff was skipped")
    const handoffEntries = (await client.getEntries()).entries.slice(beforeHandoff)
    assert(
      handoffEntries.some(
        (entry) => entry.type === "compaction" && /COBALT-731/.test(entry.summary)
      ),
      "Handoff did not persist its summary"
    )
    check("real-handoff-summary")
    assert.match(
      await run("post-handoff-context", "Which synthetic code did I originally supply? Code only."),
      /COBALT-731/
    )
    check("post-handoff-context")
    await run(
      "compaction-input",
      `Keep COBALT-731 for later. This is disposable synthetic ledger data: ${Array.from({ length: 100 }, (_, i) => `row${i}=test-value-${i};`).join(" ")} Reply with ACK only.`
    )
    const compaction = await client.compact({
      customInstructions: "Preserve COBALT-731 and 42, omit disposable ledger rows.",
    })
    assert(
      compaction.summary.length > 0 && compaction.tokensBefore > 0 && compaction.firstKeptEntryId
    )
    assert.match(compaction.summary, /COBALT-731/)
    check("real-manual-compaction")
    assert.match(
      await run(
        "post-compaction-context",
        "Which synthetic code did I originally supply? Code only."
      ),
      /COBALT-731/
    )
    check("post-compaction-context")
    const locator = adapter.getResumeLocator(session.id)
    const parsed = readOmpSession(await readFile(locator, "utf8"), locator, {
      redactText: (text) => text.replaceAll(apiKey, "[REDACTED]"),
    })
    assert.equal(parsed.session.originalSessionId, (await client.getState()).sessionId)
    assert(
      parsed.session.messages.length > 0 && JSON.stringify(parsed.session).includes("COBALT-731")
    )
    const exported = await client.exportHtml({ outputPath: join(root, "session.html") })
    const html = await readFile(exported.path, "utf8")
    const embedded = html.match(
      /<script id="session-data" type="application\/json">([^<]+)<\/script>/
    )
    assert(embedded, "Export omitted embedded session data")
    const exportedData = JSON.parse(Buffer.from(embedded[1], "base64").toString("utf8"))
    assert(JSON.stringify(exportedData).includes("COBALT-731"))
    check("real-history-import-and-html-export")
    await client.setSubagentSubscription({ level: "events" })
    const nativeStart = nativeEvents.length
    assert.match(
      await run(
        "native-subagent",
        'Call the task tool exactly once with these arguments: {"context":"Synthetic arithmetic acceptance only","tasks":[{"name":"SyntheticChild","agent":"task","model":"@default","task":"Calculate 17+25. Use no filesystem, shell, network or other tools. Return 42 via the yield tool.","solutionSpace":"A single integer result"}]}. After task returns, reply with DELEGATED only. If the child is running, do not launch it again. Do not call any other tools in the parent.'
      ),
      /DELEGATED/
    )
    const childStart = nativeEvents
      .slice(nativeStart)
      .find((event) => event.type === "subagent_lifecycle" && event.payload.status === "started")
    assert(childStart, "No native subagent started")
    // Prompt completion and background quiescence are distinct native boundaries.
    // The parent can finish its answer while the child still owns a provider call.
    const childDeadline = Date.now() + 120000
    while (
      !nativeEvents
        .slice(nativeStart)
        .some(
          (event) =>
            event.type === "subagent_lifecycle" &&
            event.payload.id === childStart.payload.id &&
            ["completed", "failed", "aborted"].includes(event.payload.status)
        ) &&
      Date.now() < childDeadline
    )
      await new Promise((resolve) => setTimeout(resolve, 50))
    assert(
      nativeEvents
        .slice(nativeStart)
        .some(
          (event) =>
            event.type === "subagent_lifecycle" &&
            event.payload.id === childStart.payload.id &&
            event.payload.status === "completed"
        ),
      `Native subagent did not complete: ${nativeEvents
        .slice(nativeStart)
        .filter((event) => event.type === "subagent_lifecycle")
        .map((event) => event.payload.status)
        .join(", ")}`
    )
    const childHistory = await client.getSubagentMessages({
      sessionFile: childStart.payload.sessionFile,
    })
    assert(childHistory.entries.length > 0 && JSON.stringify(childHistory).includes("42"))
    const settleDeadline = Date.now() + 120000
    while (!(await client.getState()).isSettled && Date.now() < settleDeadline)
      await new Promise((resolve) => setTimeout(resolve, 100))
    assert((await client.getState()).isSettled, "Parent did not settle after child completion")
    check("real-native-subagent-and-transcript")
  }
  let signalRequest
  const admitted = new Promise((resolve) => {
    signalRequest = resolve
  })
  const cancellationPrompt = "Write integers 1 through 1000 one per line, without skipping any."
  onRequest = (entry, payload) => {
    if (
      payload.messages.some(
        (message) =>
          message.role === "user" && JSON.stringify(message.content).includes(cancellationPrompt)
      )
    )
      signalRequest(entry)
  }
  let cancelError
  const cancelTurn = (async () => {
    try {
      for await (const event of adapter.prompt(session.id, {
        id: randomUUID(),
        role: "user",
        timestamp: new Date(),
        content: [
          {
            type: "text",
            text: cancellationPrompt,
          },
        ],
      }))
        void event
      return false
    } catch (error) {
      cancelError = String(error.message).replaceAll(apiKey, "[REDACTED]")
      return true
    }
  })()
  const timeout = setTimeout(() => signalRequest(), 90000)
  const cancellationRequest = await admitted
  clearTimeout(timeout)
  assert.equal(
    cancellationRequest?.status,
    200,
    `Cancellation did not reach a real successful provider request (${cancelError ?? "awaiting provider"})`
  )
  await adapter.cancel(session.id)
  assert(await cancelTurn, "Cancellation did not reject active turn")
  check("cancel-real-provider-stream")
  await adapter.disconnect()
  assert.equal(processes.size, 0)
  assert.equal(outputs.size, 0)
  assert.equal(exits.size, 0)
  check("process-and-listener-cleanup")
  assert(
    requestLog.every((r) => r.status === 200 || r.failure === "cancelled"),
    "At least one provider request failed"
  )
  console.log(
    JSON.stringify(
      {
        result: "PASS",
        provider: "deepseek",
        endpoint: "https://api.deepseek.com/chat/completions",
        model,
        upstream: "18.6.1",
        checks,
        turns,
        providerRequests: requestLog,
        released,
        stderrBytes,
      },
      null,
      2
    )
  )
} catch (error) {
  console.error(
    JSON.stringify(
      {
        result: "FAIL",
        message: String(error.message).replaceAll(apiKey, "[REDACTED]"),
        checks,
        turns,
        providerRequests: requestLog,
        stderrBytes,
      },
      null,
      2
    )
  )
  process.exitCode = 1
} finally {
  await adapter?.disconnect().catch(() => {})
  for (const child of processes.values()) child.kill("SIGKILL")
  for (const abort of pending) abort.abort()
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  await rm(root, { recursive: true, force: true })
}
