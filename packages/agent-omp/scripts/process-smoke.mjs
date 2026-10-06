/** Real OMP 18.6.1 process smoke: isolated HOME, synthetic content, loopback-only model traffic. */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { spawn, execFileSync } from "node:child_process"
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
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
  '(version 1)(allow default)(deny network*)(allow network-inbound (local ip "localhost:*"))(allow network-outbound (remote ip "localhost:*"))'
assert.match(
  execFileSync("/usr/bin/sandbox-exec", ["-p", sandbox, binary, "--version"], { encoding: "utf8" }),
  /omp\/18\.6\.1/
)
const largeAnswer = Array.from({ length: 18000 }, (_, i) =>
  createHash("sha256").update(String(i)).digest("hex")
).join("\n")
const dist = new URL("../dist/", import.meta.url)
const { OmpRpcPeer } = await import(new URL("rpc-peer.js", dist))
const { OmpSessionClient } = await import(new URL("session-client.js", dist))
const root = await mkdtemp(join(tmpdir(), "cognia-omp-smoke-"))
const home = join(root, "home"),
  cwd = join(root, "workspace"),
  agentDir = join(home, ".omp", "agent")
let child, peer
let stderr = ""
const events = []
const requests = []
let slowRequestStarted = () => {}
let adapter
const adapterChildren = new Map()
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
    if (JSON.stringify(input.messages).includes("SLOW_FIXTURE")) {
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
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" })
    const id = "fixture-chat",
      model = "fixture-model"
    const send = (data) =>
      res.write(
        `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model, ...data })}\n\n`
      )
    send({
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            content: JSON.stringify(input.messages).includes("LARGE_FIXTURE")
              ? largeAnswer
              : "Fixture response",
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
      retry: { enabled: false },
    })
  )
  const extension = join(root, "guard.mjs")
  await writeFile(
    extension,
    `import { createOmpNativeGuard } from ${JSON.stringify(fileURLToPath(new URL("native-guard.js", dist)))};
export default function(pi) {
  createOmpNativeGuard({ nonce: "smoke-guard", enforcement: { isolatedExtensions:true, providerEgressControlled:true, rebindingVerified:true }, authorize:async req=>({allow:req.kind === "bash" && req.input.command === "cognia-test-wait"}), executeDirect:async(_req,ctx,signal)=>{ctx.ui.setStatus("smoke-shell-started","waiting");return new Promise((_,reject)=>signal.addEventListener("abort",()=>reject(new Error("Cancelled")),{once:true}));}, redactResult:async v=>v, transformOutbound:v=>v, terminate:()=>process.exit(91) })(pi);
  pi.registerCommand("smoke-local", { description:"Smoke local command", handler:async()=>{} });
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
      "--no-tools",
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
    timeoutMs: 20000,
    promptTimeoutMs: 20000,
    onEvent: (frame) => events.push(frame),
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
  assert(initial.sessionId)
  assert.equal(initial.model?.provider, "fixture")
  const commands = await client.getAvailableCommands()
  assert(commands.commands.some((command) => command.name === "smoke-local"))
  const local = client.prompt({ message: "/smoke-local" })
  await local.ack
  assert.equal((await local.result).agentInvoked, false)
  await client.setSteeringMode({ mode: "all" })
  await client.setFollowUpMode({ mode: "one-at-a-time" })
  const queue = await client.removeQueuedMessage({ queue: "followUp", message: "not-present" })
  assert.equal(queue.removed, false)
  await client.setTodos({
    phases: [{ name: "Verify", tasks: [{ content: "Fixture", status: "completed" }] }],
  })
  assert.equal((await client.getState()).todoPhases[0].tasks[0].status, "completed")
  const denial = await client.bash({ command: "touch SHOULD_NOT_EXIST" })
  assert.equal(denial.exitCode, 1)
  assert.match(denial.output, /blocked by host policy/)
  const prompt = client.prompt({ message: "Synthetic smoke prompt" })
  await prompt.ack
  const result = await prompt.result
  assert.equal(result.status, "completed")
  assert.equal(result.agentInvoked, true)
  assert(requests.some((request) => request.path.endsWith("/chat/completions")))
  assert.equal((await client.getLastAssistantText()).text, "Fixture response")
  const history = await client.getMessagesPage({ limit: 1 })
  assert(history)
  await client.setSessionName({ name: "OMP package smoke" })
  const settled = await client.getState()
  assert.equal(settled.isSettled, true)
  assert.equal(settled.sessionName, "OMP package smoke")
  const readyCount = () =>
    events.filter(
      (frame) =>
        frame.type === "extension_ui_request" &&
        frame.method === "setStatus" &&
        frame.statusKey === "cognia-omp-ready"
    ).length
  const beforeFork = readyCount()
  assert.equal((await client.fork({})).cancelled, false)
  const forked = await client.getState()
  assert(readyCount() > beforeFork, "Fork did not re-attest guard binding")
  assert.notEqual(forked.sessionId, initial.sessionId)
  const branchMessages = await client.getBranchMessages()
  assert(branchMessages.messages.length > 0)
  const beforeBranch = readyCount()
  await client.branch({ entryId: branchMessages.messages[0].entryId })
  await client.getState()
  assert(readyCount() > beforeBranch, "Branch did not re-attest guard binding")
  const beforeSwitch = readyCount()
  await client.switchSession({ sessionPath: settled.sessionFile })
  await client.getState()
  assert(readyCount() > beforeSwitch, "Switch did not re-attest guard binding")
  const large = client.prompt({ message: "LARGE_FIXTURE" })
  await large.ack
  assert.equal((await large.result).status, "completed")
  assert.equal((await client.getLastAssistantText()).text, largeAnswer)
  assert((await client.getMessages()).messages.length > 0)
  const beforeNew = readyCount()
  const newSession = await client.newSession({})
  assert.equal(newSession.cancelled, false)
  assert.notEqual((await client.getState()).sessionId, initial.sessionId)
  assert(readyCount() > beforeNew, "New session did not re-attest guard binding")
  assert(
    events.some(
      (frame) =>
        frame.type === "extension_ui_request" &&
        frame.method === "setStatus" &&
        frame.statusKey === "cognia-omp-ready"
    ),
    "Native guard did not attest startup"
  )
  const { OmpRpcClientAdapter } = await import(new URL("rpc-client.js", dist))
  const outputListeners = new Set(),
    exitListeners = new Set()
  const subscribe = (listeners) => async (listener) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
  const processHost = {
    available: true,
    commandExists: async () => true,
    onStdoutRaw: subscribe(outputListeners),
    onExit: subscribe(exitListeners),
    onStdoutLine: async () => () => {},
    onStderr: async () => () => {},
    spawn: async (spec) => {
      const proc = spawn(
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
          "--no-tools",
          "--provider",
          "fixture",
          "--model",
          "fixture-model",
          "--system-prompt",
          "Reply with the synthetic fixture response.",
        ],
        { cwd: spec.cwd, env: spec.env, stdio: ["pipe", "pipe", "pipe"] }
      )
      adapterChildren.set(spec.id, proc)
      proc.stdout.on("data", (bytes) => {
        for (const fn of outputListeners) fn({ processId: spec.id, data: bytes.toString("base64") })
      })
      proc.stderr.on("data", (bytes) => {
        stderr = (stderr + bytes.toString()).slice(-10000)
      })
      proc.on("exit", (code) => {
        adapterChildren.delete(spec.id)
        for (const fn of exitListeners) fn({ processId: spec.id, code })
      })
      await new Promise((yes, no) => {
        proc.once("spawn", yes)
        proc.once("error", no)
      })
      return spec.id
    },
    send: async (id, data) => {
      const proc = adapterChildren.get(id)
      assert(proc)
      await new Promise((yes, no) => proc.stdin.write(data, (err) => (err ? no(err) : yes())))
    },
    kill: async (id) => {
      const proc = adapterChildren.get(id)
      if (!proc || proc.exitCode !== null) return
      const exited = new Promise((yes) => proc.once("exit", yes))
      proc.kill("SIGTERM")
      const timeout = setTimeout(() => proc.kill("SIGKILL"), 2000)
      await exited
      clearTimeout(timeout)
    },
  }
  let released = 0
  let shellStarted
  const shellAdmission = new Promise((resolve) => {
    shellStarted = resolve
  })
  adapter = new OmpRpcClientAdapter({
    processHost,
    outboundGate: () => true,
    probeRuntime: async () => ({ command: resolve(binary), version: "18.6.1" }),
    prepareSession: async () => ({
      cwd,
      sessionDir: join(root, "adapter-sessions"),
      trustedExtensionPath: extension,
      nonce: "smoke-guard",
      env: {
        HOME: home,
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        TMPDIR: join(root, "tmp"),
        PI_CODING_AGENT_DIR: agentDir,
        OMP_PROFILE: "",
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
    timeoutMs: 20000,
    promptTimeoutMs: 20000,
    onNativeEvent: (_sessionId, frame) => {
      if (
        frame.type === "extension_ui_request" &&
        frame.method === "setStatus" &&
        frame.statusKey === "smoke-shell-started"
      )
        shellStarted()
    },
  })
  await adapter.connect({
    id: "omp-smoke",
    protocol: "omp-rpc",
    transport: "stdio",
    name: "OMP smoke",
    enabled: true,
  })
  const session = await adapter.createSession()
  const message = (text) => ({
    id: "smoke-message",
    role: "user",
    timestamp: new Date(),
    content: [{ type: "text", text }],
  })
  const mapped = []
  for await (const event of adapter.prompt(session.id, message("Adapter fixture")))
    mapped.push(event)
  assert(
    mapped.some(
      (event) =>
        event.type === "message_delta" &&
        event.delta.type === "text" &&
        event.delta.text.includes("Fixture response")
    ),
    "Adapter did not map streamed text"
  )
  assert(mapped.some((event) => event.type === "done" && event.success === true))
  const facade = adapter.getOmpSession(session.id)
  assert.equal((await facade.fork({})).cancelled, false)
  assert.equal((await facade.newSession({})).cancelled, false)
  for await (const event of adapter.prompt(session.id, message("Save before cancel")))
    assert.notEqual(event.type, "error")
  const resumeFile = adapter.getResumeLocator(session.id)
  assert(resumeFile?.endsWith(".jsonl"))
  let startSlow
  const slowStarted = new Promise((yes) => {
    startSlow = yes
  })
  slowRequestStarted = startSlow
  const cancelled = (async () => {
    try {
      for await (const event of adapter.prompt(session.id, message("SLOW_FIXTURE"))) void event
      return null
    } catch (error) {
      return error
    }
  })()
  let slowTimer
  try {
    await Promise.race([
      slowStarted,
      new Promise((_, no) => {
        slowTimer = setTimeout(() => no(new Error("Slow fixture did not start")), 15000)
      }),
    ])
  } finally {
    clearTimeout(slowTimer)
  }
  await adapter.cancel(session.id)
  assert(await cancelled, "Cancelling the process must fail the in-flight prompt")
  assert.equal(adapter.getSession(session.id), undefined)
  const resumed = await adapter.resumeSession(session.id)
  assert.equal(adapter.getResumeLocator(resumed.id), resumeFile)
  const runningShell = adapter.executeSessionShell(resumed.id, "cognia-test-wait", {
    onPermissionRequest: async (request) => ({ requestId: request.id, granted: true }),
  })
  const shellOutcome = runningShell.then(
    () => false,
    () => true
  )
  let shellTimer
  try {
    await Promise.race([
      shellAdmission,
      new Promise((_, reject) => {
        shellTimer = setTimeout(() => reject(new Error("Delegated shell did not start")), 5000)
      }),
    ])
  } finally {
    clearTimeout(shellTimer)
  }
  assert.deepEqual(await adapter.abortSessionShell(resumed.id), { resumeRequired: true })
  assert(await shellOutcome, "Active delegated shell did not reject after process retirement")
  assert.equal(adapter.getSession(resumed.id), undefined)
  await adapter.disconnect()
  assert.equal(adapterChildren.size, 0)
  assert.equal(released, 2)
  console.log(
    JSON.stringify(
      {
        upstream: "18.6.1",
        digest,
        protocol: 2,
        checks: [
          "ready",
          "v2",
          "get_state",
          "commands",
          "local-prompt",
          "queue",
          "todos",
          "native-bash-denial",
          "loopback-model",
          "prompt_result",
          "paged-history",
          "rename",
          "new-session",
          "fork",
          "branch",
          "switch",
          "large-v2-frames",
          "adapter-stream",
          "adapter-transitions",
          "adapter-cancel",
          "adapter-native-resume",
          "adapter-active-delegated-shell-cancel",
          "adapter-cleanup",
        ],
        modelRequests: requests.length,
      },
      null,
      2
    )
  )
} catch (error) {
  console.error(stderr)
  throw error
} finally {
  await adapter?.disconnect().catch(() => {})
  for (const proc of adapterChildren.values()) proc.kill("SIGKILL")
  peer?.dispose()
  if (child && child.exitCode === null) {
    child.kill("SIGTERM")
    await Promise.race([
      new Promise((yes) => child.once("exit", yes)),
      new Promise((yes) => setTimeout(yes, 2000)),
    ])
    if (child.exitCode === null) child.kill("SIGKILL")
  }
  server.closeAllConnections()
  await new Promise((yes) => server.close(yes))
  await rm(root, { recursive: true, force: true })
}
