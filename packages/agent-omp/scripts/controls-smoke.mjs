/** Extended real OMP 18.6.1 controls acceptance: isolated HOME, synthetic content, loopback-only model traffic. */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { spawn, execFileSync } from "node:child_process"
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { createConnection } from "node:net"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const binary = process.env.OMP_BINARY
assert(binary, "Set OMP_BINARY to the downloaded official OMP 18.6.1 binary")
assert.equal(
  process.platform,
  "darwin",
  "This smoke uses macOS sandbox-exec to enforce loopback-only egress"
)
assert.equal(process.arch, "arm64", "This smoke verifies the official darwin-arm64 release digest")
const digest = createHash("sha256")
  .update(await readFile(binary))
  .digest("hex")
assert.equal(
  digest,
  "b5ca5cd17b8cc09ece36845988fd401f7d1002e1ab5b95600e0f328924246d52",
  "OMP release SHA256 mismatch"
)
const sandbox =
  '(version 1)(allow default)(deny network*)(allow network-inbound (local ip "localhost:*"))(allow network-outbound (remote ip "localhost:*"))(allow network* (local unix-socket) (remote unix-socket))'
assert.match(
  execFileSync("/usr/bin/sandbox-exec", ["-p", sandbox, binary, "--version"], { encoding: "utf8" }),
  /omp\/18\.6\.1/
)
const dist = new URL("../dist/", import.meta.url)
const { OmpRpcPeer } = await import(new URL("rpc-peer.js", dist))
const { OmpSessionClient } = await import(new URL("session-client.js", dist))
const root = await mkdtemp("/tmp/ompc-")
const home = join(root, "home"),
  cwd = join(root, "workspace"),
  agentDir = join(home, ".omp", "agent")
let child, peer
let stderr = ""
const events = []
const requests = []
const checks = []
const checked = (name) => {
  checks.push(name)
  console.log(`PASS ${name}`)
}
let uriContent = "initial virtual file"
const uriOperations = []
let serverMode = "normal"
let failedRequests = 0
let autoRetryAction
let retryAbort
let slowRequestStarted = () => {}
const server = createServer(async (req, res) => {
  try {
    let body = ""
    for await (const chunk of req) body += chunk
    const input = body ? JSON.parse(body) : {}
    requests.push({ path: req.url, input })
    if (req.url?.endsWith("/models")) {
      res.setHeader("Content-Type", "application/json")
      res.end(JSON.stringify({ data: [{ id: "fixture-model", object: "model" }] }))
      return
    }
    assert(req.url?.endsWith("/chat/completions"), `Unexpected fixture endpoint ${req.url}`)
    if (
      JSON.stringify(input.messages.findLast((m) => m.role === "user")?.content).includes(
        "SLOW_FIXTURE"
      ) ||
      JSON.stringify(input.messages.findLast((m) => m.role === "user")?.content).includes(
        "CHILD_SLOW"
      )
    ) {
      slowRequestStarted()
      await new Promise((yes) => {
        const timer = setTimeout(yes, 5000)
        res.once("close", () => {
          clearTimeout(timer)
          yes()
        })
      })
      if (res.destroyed) return
    }
    if (serverMode === "failure" || (serverMode === "retry" && failedRequests++ === 0)) {
      res.writeHead(503, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: { message: "Synthetic overload", type: "server_error" } }))
      return
    }
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" })
    const id = "fixture-chat",
      model = "fixture-model"
    const send = (data) =>
      res.write(
        `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model, ...data })}\n\n`
      )
    const userMessage = input.messages.findLast((m) => m.role === "user")
    const marker = JSON.stringify(userMessage?.content)
    const userIndex = input.messages.lastIndexOf(userMessage)
    const toolComplete = input.messages.slice(userIndex + 1).some((m) => m.role === "tool")
    const tool = input.tools?.some((t) => t.function?.name === "yield")
      ? { name: "yield", arguments: JSON.stringify({ data: { result: "child complete" } }) }
      : marker?.includes("PARENT_SUBAGENT")
        ? {
            name: "task",
            arguments: JSON.stringify({
              context: "Synthetic native acceptance",
              tasks: [
                {
                  name: "FixtureChild",
                  agent: "task",
                  model: "@default",
                  task: marker.includes("CANCEL") ? "CHILD_SLOW" : "CHILD_FAST",
                  solutionSpace: "fixed fixture response",
                },
              ],
            }),
          }
        : marker?.includes("URI_READ")
          ? { name: "read", arguments: JSON.stringify({ path: "smoke://doc" }) }
          : marker?.includes("URI_WRITE")
            ? {
                name: "write",
                arguments: JSON.stringify({ path: "smoke://doc", content: "updated virtual file" }),
              }
            : marker?.includes("HOST_CALL")
              ? { name: "host_check", arguments: JSON.stringify({ value: "host-payload" }) }
              : null
    if (tool && !toolComplete) {
      send({
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [{ index: 0, id: "call-fixture", type: "function", function: tool }],
            },
            finish_reason: null,
          },
        ],
      })
      send({
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      })
      res.end("data: [DONE]\n\n")
      return
    }
    send({
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            content: "Fixture response",
          },
          finish_reason: null,
        },
      ],
    })
    send({
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    })
    res.end("data: [DONE]\n\n")
  } catch (error) {
    res.writeHead(500)
    res.end(String(error))
  }
})
await new Promise((yes, no) => {
  server.once("error", no)
  server.listen(0, "127.0.0.1", yes)
})
try {
  await Promise.all([
    mkdir(agentDir, { recursive: true }),
    mkdir(cwd, { recursive: true }),
    mkdir(join(root, "tmp")),
  ])
  const port = server.address().port
  await writeFile(
    join(agentDir, "models.yml"),
    JSON.stringify({
      providers: {
        fixture: {
          baseUrl: `http://127.0.0.1:${port}/v1`,
          api: "openai-completions",
          auth: "none",
          models: [
            {
              id: "fixture-reasoning",
              name: "Fixture reasoning",
              reasoning: true,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128000,
              maxTokens: 1024,
            },
            {
              id: "fixture-model",
              name: "Fixture model",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128000,
              maxTokens: 1024,
            },
          ],
        },
      },
    })
  )
  await writeFile(
    join(agentDir, "config.yml"),
    JSON.stringify({
      models: {
        default: "fixture/fixture-model",
        smol: "fixture/fixture-model",
        slow: "fixture/fixture-model",
      },
      compaction: { enabled: false },
      spelling: { autocomplete: "ngram" },
      async: { enabled: false },
      retry: { enabled: false, maxRetries: 2, baseDelayMs: 50 },
    })
  )
  const extension = join(root, "guard.mjs")
  await writeFile(
    extension,
    `import { createOmpNativeGuard } from ${JSON.stringify(fileURLToPath(new URL("native-guard.js", dist)))};
export default function(pi) {
  createOmpNativeGuard({ nonce: "smoke-guard", enforcement: { isolatedExtensions:true, providerEgressControlled:true, rebindingVerified:true }, authorize:async req=>({allow:req.kind === "tool" ? ["read","write","host_check","task","yield"].includes(req.toolName) : req.input.command === "printf allowed-shell"}), executeDirect:async req=>{
    const proc = Bun.spawn(["/bin/sh","-c",req.input.command],{cwd:process.cwd(),stdout:"pipe",stderr:"pipe"});
    const output=await new Response(proc.stdout).text(); const exitCode=await proc.exited;
    return {output,exitCode,cancelled:false,truncated:false,totalLines:1,totalBytes:output.length,outputLines:1,outputBytes:output.length};
  }, redactResult:async v=>v, transformOutbound:v=>v, terminate:()=>process.exit(91) })(pi);
  pi.registerCommand("smoke-local", { description:"Smoke local command", handler:async()=>{} });
  pi.registerCommand("smoke-dialogs", {description:"Fixture dialog roundtrip",handler:async(_args,ctx)=>{
    const output={select:await ctx.ui.select("fixture-select",["one","two"]),confirm:await ctx.ui.confirm("fixture-confirm","Continue"),input:await ctx.ui.input("fixture-input"),editor:await ctx.ui.editor("fixture-editor","before"),cancel:await ctx.ui.input("fixture-cancel"),ask:await ctx.ui.askDialog([{id:"q1",question:"Fixture choice",options:[{label:"Alpha"}]}])};
    ctx.ui.setStatus("fixture-dialog-result",JSON.stringify(output));
  }});
}
`
  )
  child = spawn(
    "/usr/bin/sandbox-exec",
    [
      "-p",
      sandbox,
      resolve(binary),
      "--mode",
      "rpc",
      "--cwd",
      cwd,
      "--provider",
      "fixture",
      "--model",
      "fixture-model",
      "--session-dir",
      join(root, "sessions"),
      "--trusted-extension",
      extension,
      "--no-skills",
      "--no-rules",
      "--no-lsp",
      "--no-title",
      "--no-prewalk",
      "--tools",
      "read,write,task",
      "--system-prompt",
      "Reply with the synthetic fixture response.",
    ],
    {
      cwd,
      env: {
        HOME: home,
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        TMPDIR: join(root, "tmp"),
        PI_CODING_AGENT_DIR: agentDir,
        OMP_PROFILE: "",
        OMP_DAEMON_IDLE_GRACE_MS: "100",
        TERM: "dumb",
        NO_COLOR: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    }
  )
  peer = new OmpRpcPeer({
    send: (line) =>
      new Promise((yes, no) => child.stdin.write(line, (error) => (error ? no(error) : yes()))),
    outboundGate: () => true,
    timeoutMs: 120000,
    promptTimeoutMs: 120000,
    onEvent: (frame) => {
      events.push(frame)
      if (frame.type === "auto_retry_start" && autoRetryAction === "recover") serverMode = "normal"
      if (frame.type === "auto_retry_start" && autoRetryAction === "abort")
        retryAbort = peer.request("abort_retry")
      if (frame.type === "extension_ui_request") {
        const base = { type: "extension_ui_response", id: frame.id }
        let reply
        if (frame.method === "select") reply = { ...base, value: "two" }
        if (frame.method === "confirm") reply = { ...base, confirmed: true }
        if (frame.method === "input")
          reply =
            frame.title === "fixture-cancel"
              ? { ...base, cancelled: true }
              : { ...base, value: "typed input" }
        if (frame.method === "editor") reply = { ...base, value: "edited text" }
        if (frame.method === "ask")
          reply = { ...base, answers: [{ id: "q1", selectedOptions: ["Alpha"] }] }
        if (reply) void peer.sendFrame(reply)
      }
      if (frame.type === "host_uri_request") {
        uriOperations.push(frame.operation)
        if (frame.operation === "write") uriContent = frame.content
        void peer.sendFrame({
          type: "host_uri_result",
          id: frame.id,
          ...(frame.operation === "read" ? { content: uriContent, contentType: "text/plain" } : {}),
        })
      }
      if (frame.type === "host_tool_call") {
        assert.equal(frame.arguments.value, "host-payload")
        void peer.sendFrame({
          type: "host_tool_result",
          id: frame.id,
          result: { content: [{ type: "text", text: "host result" }] },
        })
      }
    },
  })
  child.stdout.on("data", (bytes) => peer.feed(bytes))
  child.stderr.on("data", (bytes) => {
    stderr = (stderr + bytes.toString()).slice(-10000)
  })
  child.on("error", (error) => peer.dispose(error))
  child.on("exit", () => peer.end())
  await peer.ready()
  assert.equal(peer.protocolVersion, 2)
  const client = new OmpSessionClient({
    request: peer.request.bind(peer),
    prompt: peer.prompt.bind(peer),
  })
  const initial = await client.getState()
  assert.equal(initial.model.provider, "fixture")
  checked("ready-v2-and-isolated-fixture-model")
  const models = await client.getAvailableModels()
  assert(models.models.some((m) => m.id === "fixture-reasoning"))
  assert.equal(
    (await client.setModel({ provider: "fixture", modelId: "fixture-reasoning" })).id,
    "fixture-reasoning"
  )
  assert((await client.getAvailableThinkingLevels()).levels.includes("high"))
  await client.setThinkingLevel({ level: "high" })
  assert.equal((await client.getState()).thinkingLevel, "high")
  assert(await client.cycleThinkingLevel())
  assert(await client.cycleModel())
  await client.setModel({ provider: "fixture", modelId: "fixture-model" })
  checked("models-and-thinking-set-cycle-readback")
  await assert.rejects(client.setFastMode({ enabled: true }), /Fast mode is unavailable/)
  assert.equal((await client.getState()).fastModeActive, false)
  checked("unsupported-fast-mode-rejects")
  for (const mode of ["streaming", "idle", "off"])
    assert.equal((await client.setCacheWarming({ mode })).mode, mode)
  await client.setSteeringMode({ mode: "all" })
  await client.setFollowUpMode({ mode: "one-at-a-time" })
  await client.setInterruptMode({ mode: "wait" })
  await client.setAutoCompaction({ enabled: true })
  let state = await client.getState()
  assert.equal(state.steeringMode, "all")
  assert.equal(state.followUpMode, "one-at-a-time")
  assert.equal(state.interruptMode, "wait")
  assert.equal(state.autoCompactionEnabled, true)
  await client.setAutoCompaction({ enabled: false })
  checked("cache-queue-interrupt-compaction-policy-readback")
  assert.equal((await client.goal({ op: "get" })).goal, null)
  let goal = await client.goal({
    op: "create",
    objective: "Synthetic validation goal",
    token_budget: 1000,
  })
  assert.equal(goal.goal.objective, "Synthetic validation goal")
  assert.equal((await client.goal({ op: "pause" })).goal.status, "paused")
  assert.equal((await client.goal({ op: "resume" })).goal.status, "active")
  assert.equal((await client.goal({ op: "drop" })).goal, null)
  checked("goal-create-pause-resume-drop")
  const todos = [
    {
      name: "Acceptance",
      tasks: [
        { content: "First", status: "completed" },
        { content: "Second", status: "pending" },
      ],
    },
  ]
  assert.deepEqual((await client.setTodos({ phases: todos })).todoPhases, todos)
  assert.deepEqual((await client.getState()).todoPhases, todos)
  await client.setTodos({ phases: [] })
  checked("todo-roundtrip-and-clear")
  await client.setAskDialog({ enabled: true })
  const dialogs = client.prompt({ message: "/smoke-dialogs" })
  assert.equal((await dialogs.result).agentInvoked, false)
  for (let i = 0; i < 100 && !events.some((e) => e.statusKey === "fixture-dialog-result"); i++)
    await new Promise((r) => setTimeout(r, 20))
  const dialogResult = events.find(
    (e) => e.type === "extension_ui_request" && e.statusKey === "fixture-dialog-result"
  )
  assert(dialogResult, "Extension dialog command did not complete")
  const replies = JSON.parse(dialogResult.statusText)
  assert.equal(replies.select, "two")
  assert.equal(replies.confirm, true)
  assert.equal(replies.input, "typed input")
  assert.equal(replies.editor, "edited text")
  assert.equal(replies.cancel, undefined)
  assert(replies.ask)
  checked("native-select-confirm-input-editor-ask-and-cancel-roundtrips")
  const allowed = await client.bash({ command: "printf allowed-shell" })
  assert.equal(allowed.exitCode, 0)
  assert.equal(allowed.output, "allowed-shell")
  const denied = await client.bash({ command: "touch SHOULD_NOT_EXIST" })
  assert.equal(denied.exitCode, 1)
  await assert.rejects(readFile(join(cwd, "SHOULD_NOT_EXIST")), { code: "ENOENT" })
  await client.abortBash()
  checked("native-guard-shell-allow-and-deny-side-effects")
  assert.deepEqual(
    (await client.setHostUriSchemes({ schemes: [{ scheme: "smoke", writable: true }] })).schemes,
    ["smoke"]
  )
  async function prompt(message) {
    const ticket = client.prompt({ message })
    await ticket.ack
    const result = await ticket.result
    assert.equal(result.status, "completed", JSON.stringify(result))
    return result
  }
  await prompt("URI_READ")
  assert(uriOperations.includes("read"), "Native read tool did not invoke host URI callback")
  await prompt("URI_WRITE")
  assert.equal(uriContent, "updated virtual file")
  assert(uriOperations.includes("write"))
  checked("native-tools-host-uri-read-write-roundtrips")
  const hostTools = await client.setHostTools({
    tools: [
      {
        name: "host_check",
        description: "Synthetic host tool",
        loadMode: "essential",
        parameters: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
        },
      },
    ],
  })
  assert(hostTools.toolNames.includes("host_check"))
  await prompt("HOST_CALL")
  assert(events.some((e) => e.type === "host_tool_call"))
  checked("host-tool-registration-and-native-execution")
  await client.setHostTools({ tools: [] })
  await client.setHostUriSchemes({ schemes: [] })
  await prompt("Transcript for history acceptance")
  const entries = await client.getEntries()
  assert(entries.entries.length > 3)
  assert(entries.leafId)
  const incremental = await client.getEntries({ since: entries.entries.at(-2).id })
  assert(incremental.entries.length < entries.entries.length)
  const tree = await client.getTree()
  assert(tree.tree.length > 0)
  assert.equal(tree.leafId, entries.leafId)
  const messages = (await client.getMessages()).messages
  const page = await client.getMessagesPage({ limit: 1 })
  assert.equal(page.messages.length, 1)
  assert.equal(page.totalMessages, messages.length)
  assert(page.nextCursor)
  const next = await client.getMessagesPage({ limit: 1, cursor: page.nextCursor })
  assert.equal(next.messages.length, 1)
  assert.notDeepEqual(next.messages, page.messages)
  const exported = await client.exportHtml({ outputPath: join(root, "export.html") })
  const html = await readFile(exported.path, "utf8")
  const embedded = html.match(
    /<script id="session-data" type="application\/json">([^<]+)<\/script>/
  )
  assert(embedded, "Export omitted embedded transcript")
  assert.match(
    Buffer.from(embedded[1], "base64").toString("utf8"),
    /Transcript for history acceptance/
  )
  checked("entries-incremental-tree-pagination-and-html-export")
  const stats = await client.getSessionStats()
  assert(stats.assistantMessages > 0)
  assert(stats.toolCalls > 0)
  assert(stats.tokens.total > 0)
  assert.equal(stats.cost, 0)
  checked("session-usage-including-zero-cost-and-tools")
  assert.equal((await client.setSubagentSubscription({ level: "events" })).level, "events")
  assert.deepEqual((await client.getSubagents()).subagents, [])
  assert.equal((await client.cancelSubagent({ subagentId: "missing" })).cancelled, false)
  await assert.rejects(client.steerSubagent({ subagentId: "missing", message: "synthetic" }))
  await assert.rejects(client.getSubagentMessages({ subagentId: "missing" }))
  checked("subagent-idle-subscription-and-missing-id-errors")
  assert((await client.getLoginProviders()).providers.length > 0)
  await assert.rejects(client.login({ providerId: "unknown-fixture-provider" }))
  checked("login-catalog-and-invalid-provider-without-authentication")
  const filtered = await client.setEventFilter({ events: ["message_end"], messageUpdates: "delta" })
  assert.deepEqual(filtered.events, ["message_end"])
  const start = events.length
  await prompt("Filter acceptance")
  assert(events.slice(start).some((e) => e.type === "message_end"))
  assert(!events.slice(start).some((e) => e.type === "message_start"))
  await client.setEventFilter({ events: null, messageUpdates: "full" })
  checked("native-event-filter-delivery")
  await client.newSession({})
  const slowStarted = new Promise((resolve) => {
    slowRequestStarted = resolve
  })
  const slow = client.prompt({ message: "SLOW_FIXTURE queue ownership" })
  await slow.ack
  await slowStarted
  await client.followUp({ message: "follow-first" })
  await client.followUp({ message: "follow-second" })
  await client.steer({ message: "steer-first" })
  let queued = (await client.getState()).queuedMessages
  assert(queued.followUp.includes("follow-first"))
  assert(queued.followUp.includes("follow-second"))
  assert(queued.steering.includes("steer-first"))
  assert.equal((await client.promoteQueuedMessage({ message: "follow-first" })).promoted, true)
  queued = (await client.getState()).queuedMessages
  assert(queued.steering.includes("follow-first"))
  assert(!queued.followUp.includes("follow-first"))
  for (const message of queued.steering)
    assert.equal((await client.removeQueuedMessage({ queue: "steering", message })).removed, true)
  for (const message of queued.followUp)
    assert.equal((await client.removeQueuedMessage({ queue: "followUp", message })).removed, true)
  assert.equal(
    (await client.removeQueuedMessage({ queue: "followUp", message: "missing" })).removed,
    false
  )
  await client.abort()
  assert.equal((await slow.result).status, "aborted")
  checked("busy-queue-steer-follow-up-promote-remove-and-abort")
  const replaceStarted = new Promise((resolve) => {
    slowRequestStarted = resolve
  })
  const replaced = client.prompt({ message: "SLOW_FIXTURE replacement" })
  await replaced.ack
  await replaceStarted
  const replacement = client.abortAndPrompt({ message: "Replacement prompt" })
  await replacement.ack
  assert.equal((await replaced.result).status, "aborted")
  assert.equal((await replacement.result).status, "completed")
  checked("abort-and-prompt-replaces-active-turn")
  serverMode = "retry"
  failedRequests = 0
  await prompt("Provider retry recovery")
  assert(failedRequests >= 2)
  checked("provider-transient-503-retry-recovers")
  serverMode = "failure"
  await client.setAutoRetry({ enabled: false })
  const failing = client.prompt({ message: "Fault acceptance" })
  await failing.ack
  const error = await failing.result
  assert.equal(error.status, "error")
  assert.equal(error.error.retryable, true)
  checked("provider-503-terminal-error-and-retryability")
  serverMode = "normal"
  await prompt("Recovery after failure")
  checked("session-remains-usable-after-provider-failure")
  await client.newSession({})
  await client.setSubagentSubscription({ level: "events" })
  const startIndex = events.length
  const taskRun = client.prompt({ message: "PARENT_SUBAGENT CANCEL" })
  await taskRun.ack
  for (
    let i = 0;
    i < 200 &&
    !events
      .slice(startIndex)
      .some((e) => e.type === "subagent_lifecycle" && e.payload.status === "started");
    i++
  )
    await new Promise((r) => setTimeout(r, 20))
  const started = events
    .slice(startIndex)
    .find((e) => e.type === "subagent_lifecycle" && e.payload.status === "started")
  assert(started, "Native task did not start a subagent")
  const subId = started.payload.id
  const active = await client.getSubagents()
  assert(active.subagents.some((s) => s.id === subId))
  await client.steerSubagent({ subagentId: subId, message: "Continue synthetic response" })
  assert.equal((await client.cancelSubagent({ subagentId: subId })).cancelled, true)
  assert.equal((await taskRun.result).status, "completed")
  assert(
    events
      .slice(startIndex)
      .some(
        (e) =>
          e.type === "subagent_lifecycle" &&
          e.payload.id === subId &&
          e.payload.status === "aborted"
      )
  )
  const childHistory = await client.getSubagentMessages({
    sessionFile: started.payload.sessionFile,
  })
  assert(childHistory.entries.length > 0)
  const incrementalChild = await client.getSubagentMessages({
    sessionFile: started.payload.sessionFile,
    fromByte: childHistory.nextByte,
  })
  assert.equal(incrementalChild.entries.length, 0)
  checked("active-native-subagent-subscribe-steer-cancel-and-transcript")
  const successStart = events.length
  await prompt("PARENT_SUBAGENT SUCCESS")
  assert(
    events
      .slice(successStart)
      .some((e) => e.type === "subagent_lifecycle" && e.payload.status === "completed")
  )
  assert(events.slice(successStart).some((e) => e.type === "subagent_event"))
  checked("native-subagent-yield-completion-and-event-stream")
  await client.setAutoRetry({ enabled: true })
  serverMode = "failure"
  autoRetryAction = "recover"
  const retryStart = events.length
  await prompt("Agent auto-retry recovery")
  for (
    let i = 0;
    i < 100 && !events.slice(retryStart).some((e) => e.type === "auto_retry_end");
    i++
  )
    await new Promise((r) => setTimeout(r, 20))
  assert(events.slice(retryStart).some((e) => e.type === "auto_retry_start"))
  assert(events.slice(retryStart).some((e) => e.type === "auto_retry_end" && e.success))
  checked("agent-auto-retry-start-end-and-recovery")
  serverMode = "failure"
  autoRetryAction = "abort"
  const abortRetryStart = events.length
  const retrying = client.prompt({ message: "Abort active agent retry" })
  await retrying.ack
  const retryOutcome = await retrying.result
  await retryAbort
  assert(events.slice(abortRetryStart).some((e) => e.type === "auto_retry_start"))
  assert(events.slice(abortRetryStart).some((e) => e.type === "auto_retry_end" && !e.success))
  assert(["aborted", "error"].includes(retryOutcome.status))
  autoRetryAction = undefined
  serverMode = "normal"
  await client.setAutoRetry({ enabled: false })
  await prompt("Recovery after abort retry")
  checked("active-agent-retry-abort-and-subsequent-prompt")
  const prediction = await client.predictWord({ text: "please re", cursor: 9 })
  assert.equal(typeof prediction.suffix, "string", "Enabled ngram did not produce a suggestion")
  assert(prediction.suffix.length > 0)
  await client.predictWordFeedback({
    text: "please re",
    cursor: 9,
    suggestion: prediction.suffix,
    accepted: true,
  })
  assert.equal((await client.predictWord({ text: "/command", cursor: 8 })).suffix, null)
  checked("enabled-ngram-prediction-feedback-and-code-gate")
  const oldSession = await client.getState()
  await client.newSession({})
  const reopened = await client.openSession({ sessionDir: join(root, "sessions") })
  assert.equal(reopened.resumed, true)
  assert.equal(reopened.sessionId, oldSession.sessionId)
  checked("open-session-resumes-persisted-transcript")
  console.log(
    JSON.stringify(
      {
        status: "passed",
        version: "18.6.1",
        checks: checks.length,
        items: checks,
        providerRequests: requests.filter((r) => r.path.endsWith("/chat/completions")).length,
        network: "Seatbelt loopback only",
        limitations: [
          "Cloud provider quality not asserted by local fixture",
          "Live voice and OAuth authentication not attempted",
        ],
      },
      null,
      2
    )
  )
} catch (error) {
  console.error(stderr)
  console.error(
    JSON.stringify(
      events
        .filter((e) =>
          ["auto_retry_start", "auto_retry_end", "prompt_result", "session_settled"].includes(
            e.type
          )
        )
        .slice(-15)
    )
  )
  console.error(
    JSON.stringify(
      events
        .filter((e) => e.type === "extension_error" || e.type === "extension_ui_request")
        .slice(-15)
    )
  )
  throw error
} finally {
  peer?.dispose()
  child?.kill("SIGKILL")
  await new Promise((resolve) => server.close(resolve))
  // Prediction runs under its own broker. Stop only sockets inside this fresh HOME.
  const socketPaths = (await readdir(root, { recursive: true, withFileTypes: true }))
    .filter((e) => e.isSocket())
    .map((e) => join(e.parentPath, e.name))
  for (const socketPath of socketPaths) {
    let request = { id: 999, op: "shutdown" }
    if (socketPath.endsWith("/broker.sock")) {
      const token = await readFile(
        socketPath.replace(/broker\.sock$/, "broker.token"),
        "utf8"
      ).catch(() => null)
      if (!token) continue
      request = { id: "cleanup", token: token.trim(), operation: { op: "shutdown" } }
    }
    await new Promise((resolve) => {
      const socket = createConnection(socketPath)
      const timer = setTimeout(() => {
        socket.destroy()
        resolve()
      }, 1000)
      socket.once("connect", () => socket.end(JSON.stringify(request) + "\n"))
      socket.once("error", () => {
        clearTimeout(timer)
        resolve()
      })
      socket.once("close", () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
  await rm(root, { recursive: true, force: true })
}
