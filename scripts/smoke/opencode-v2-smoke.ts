/**
 * Exercise the current OpenCode V2 protocol against an isolated real service.
 * Run: node --import tsx scripts/smoke/opencode-v2-smoke.ts /path/to/opencode --adapter
 * Uses fresh XDG state, a temporary workspace, and a deterministic localhost model
 * fixture; requires no model credentials and never calls an external model.
 */
import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { createServer } from "node:http"
import { setTimeout as delay } from "node:timers/promises"
import type { V2Event } from "@opencode/client"
import type { ExternalAgentEvent, ExternalAgentMessage } from "../../types/agent/external-agent"

async function localModelFixture() {
  const requests: Array<Record<string, unknown>> = []
  let cancelledConnections = 0
  const server = createServer(async (request, response) => {
    try {
      let raw = ""
      for await (const chunk of request) raw += chunk
      const body = JSON.parse(raw) as Record<string, unknown>
      requests.push(body)
      const messages = body.messages as Array<{ role: string; content: unknown }>
      const lastUser = messages.filter((message) => message.role === "user").at(-1)
      const userText = JSON.stringify(lastUser?.content ?? "")
      const afterTool = messages.at(-1)?.role === "tool"
      const output = afterTool ? "TOOL_COMPLETE" : "TEXT_COMPLETE"
      if (body.stream !== true) {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(
          JSON.stringify({
            id: "fixture",
            object: "chat.completion",
            created: 1,
            model: "fixture",
            choices: [
              { index: 0, message: { role: "assistant", content: output }, finish_reason: "stop" },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
          })
        )
        return
      }
      response.writeHead(200, { "content-type": "text/event-stream" })
      const chunk = (delta: object, finish: string | null = null) =>
        response.write(
          `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
        )
      chunk({ role: "assistant" })
      if (userText.includes("SMOKE_CANCEL")) {
        chunk({ content: "CANCEL_PENDING" })
        response.on("close", () => {
          cancelledConnections++
        })
        return
      }
      chunk({ reasoning_content: "Fixture reasoning" })
      if (userText.includes("SMOKE_TOOL") && !afterTool) {
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "call_fixture",
              type: "function",
              function: {
                name: "shell",
                arguments: JSON.stringify({
                  command: "printf 'cognia fixture tool'",
                  description: "Print fixture output",
                }),
              },
            },
          ],
        })
        chunk({}, "tool_calls")
      } else {
        chunk({ content: output })
        chunk({}, "stop")
      }
      response.write(
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })}\n\n`
      )
      response.end("data: [DONE]\n\n")
    } catch (error) {
      response.writeHead(500)
      response.end(error instanceof Error ? error.message : String(error))
    }
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  return {
    requests,
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    cancelledConnections: () => cancelledConnections,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    },
  }
}

async function main() {
  const { OpenCode } = await import("@opencode/client")
  const { Service } = await import("@opencode/client/service")
  const executable =
    process.argv.slice(2).find((argument) => argument !== "--adapter") ?? "opencode"
  const version = execFileSync(executable, ["--version"], { encoding: "utf8" }).trim()
  assert.match(version, /\bv?2\.\d+\.\d+/)
  const scratch = await mkdtemp(join(tmpdir(), "cognia-opencode-v2-smoke-"))
  const workspace = join(scratch, "workspace")
  const state = join(scratch, "state")
  const registration = join(state, "opencode", "service.json")
  const directories = [workspace, state, "home", "data", "config", "cache"].map((value) =>
    value.startsWith(scratch) ? value : join(scratch, value)
  )
  await Promise.all(directories.map((directory) => mkdir(directory, { recursive: true })))
  await writeFile(join(workspace, "README.md"), "OpenCode V2 isolated protocol smoke.\n")
  const fixture = await localModelFixture()
  await writeFile(
    join(workspace, "opencode.json"),
    JSON.stringify({
      model: "fixture/fixture",
      agents: {
        smoke: { description: "Isolated smoke agent", mode: "primary" },
      },
      commands: {
        smoke: { template: "SMOKE_TEXT $ARGUMENTS", description: "Run the local protocol fixture" },
      },
      providers: {
        fixture: {
          package: "@opencode/ai/providers/openai-compatible",
          env: ["COGNIA_FIXTURE_API_KEY"],
          settings: { baseURL: fixture.baseURL },
          models: {
            fixture: {
              name: "Deterministic local fixture",
              capabilities: { tools: true, input: ["text"], output: ["text"] },
              compatibility: { reasoningField: "reasoning_content" },
              limit: { context: 100000, output: 1000 },
            },
          },
        },
      },
    })
  )
  const child = spawn(
    executable,
    ["serve", "--service", "--hostname", "127.0.0.1", "--port", "0"],
    {
      cwd: workspace,
      env: {
        NODE_ENV: "test",
        PATH: process.env.PATH,
        TMPDIR: process.env.TMPDIR,
        LANG: "en_US.UTF-8",
        HOME: join(scratch, "home"),
        XDG_STATE_HOME: state,
        XDG_DATA_HOME: join(scratch, "data"),
        XDG_CONFIG_HOME: join(scratch, "config"),
        XDG_CACHE_HOME: join(scratch, "cache"),
        COGNIA_FIXTURE_API_KEY: "isolated-fixture",
      },
      stdio: ["ignore", "ignore", "pipe"],
    }
  )
  let startupError = ""
  child.stderr.on("data", (chunk: Buffer) => {
    startupError = (startupError + chunk.toString()).slice(-4_000)
  })
  child.on("error", (error) => {
    startupError = error.message
  })
  const sessions: string[] = []
  let client: ReturnType<typeof OpenCode.make> | undefined
  const eventController = new AbortController()
  let eventTask: Promise<void> | undefined
  const checks: string[] = []
  const checked = (name: string) => {
    checks.push(name)
    console.log(`PASS ${name}`)
  }
  const request = () => ({ signal: AbortSignal.timeout(30_000) })
  try {
    let endpoint: Awaited<ReturnType<typeof Service.discover>>
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`OpenCode exited during startup: ${startupError}`)
      }
      endpoint = await Service.discover({
        file: registration,
        version: (value) => value.startsWith("2."),
      })
      if (endpoint) break
      await delay(200)
    }
    assert.ok(endpoint, `OpenCode did not become ready: ${startupError}`)
    checked("registered service discovery and authentication")
    client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
    const status = await client.server.status(request())
    assert.match(status.version, /^2\./)
    assert.ok(status.pid > 0)
    checked("health contract")

    const observed: V2Event[] = []
    eventTask = (async () => {
      for await (const event of client!.event.subscribe({ signal: eventController.signal })) {
        observed.push(event)
      }
    })().catch((error: unknown) => {
      if (!eventController.signal.aborted) throw error
    })
    const connectedDeadline = Date.now() + 10_000
    while (
      !observed.some((event) => event.type === "server.connected") &&
      Date.now() < connectedDeadline
    ) {
      await delay(50)
    }
    assert.ok(
      observed.some((event) => event.type === "server.connected"),
      "SSE server.connected missing"
    )
    const location = { directory: workspace }
    const agents = await client.agent.list({ location }, request())
    const models = await client.model.list({ location }, request())
    const commands = await client.command.list({ location }, request())
    assert.ok(Array.isArray(agents.data))
    assert.ok(Array.isArray(models.data))
    assert.ok(Array.isArray(commands.data))
    checked("agent/model/command catalogs")

    const created = await client.session.create(
      { location, title: "Cognia protocol smoke" },
      request()
    )
    sessions.push(created.id)
    assert.equal(created.location.directory, workspace)
    const sessionID = created.id
    const listed = await client.session.list({ directory: workspace }, request())
    assert.ok(listed.data.some((session) => session.id === sessionID))
    assert.equal((await client.session.get({ sessionID }, request())).id, sessionID)
    await client.session.update({ sessionID, title: "Cognia resumed smoke" }, request())
    assert.equal((await client.session.get({ sessionID }, request())).title, "Cognia resumed smoke")
    checked("session create/list/get/resume/rename")

    await client.session.shell({ sessionID, command: "printf 'cognia protocol smoke'" }, request())
    await client.session.wait({ sessionID }, request())
    const forked = await client.session.fork({ sessionID }, request())
    sessions.push(forked.id)
    assert.notEqual(forked.id, sessionID)
    assert.equal(forked.fork?.sessionID, sessionID)
    checked("session fork with current boundary contract")

    // Built-in agents materialize lazily: the catalog is empty until a session
    // exists at the location, so re-list after session creation.
    const agentsAfterSession = await client.agent.list({ location }, request())
    const agent = agentsAfterSession.data.find(
      (item) => item.mode === "primary" || item.mode === "all"
    )
    assert.ok(agent, "Expected a primary built-in agent")
    await client.session.switchAgent({ sessionID, agent: agent.id }, request())
    assert.equal((await client.session.get({ sessionID }, request())).agent, agent.id)
    const model = models.data[0]
    if (model) {
      const reference = { id: model.id, providerID: model.providerID }
      await client.session.switchModel({ sessionID, model: reference }, request())
      const selected = (await client.session.get({ sessionID }, request())).model
      assert.equal(selected?.id, reference.id)
      assert.equal(selected?.providerID, reference.providerID)
      checked("session model selection")
    }
    await client.session.update(
      { sessionID, permissions: [{ action: "*", resource: "*", effect: "ask" }] },
      request()
    )
    assert.equal(
      (await client.session.get({ sessionID }, request())).permissions?.[0]?.effect,
      "ask"
    )
    await client.session.interrupt({ sessionID }, request())
    await client.session.wait({ sessionID }, request())
    await client.message.list({ sessionID }, request())
    checked("agent selection/permission rules/interrupt/wait/messages")

    const eventDeadline = Date.now() + 10_000
    while (
      !observed.some(
        (event) => event.type === "session.created" && event.data.sessionID === sessionID
      ) &&
      Date.now() < eventDeadline
    ) {
      await delay(50)
    }
    assert.ok(
      observed.some(
        (event) => event.type === "session.created" && event.data.sessionID === sessionID
      )
    )
    checked("live SSE session.created envelope")

    if (process.argv.includes("--adapter")) {
      // Bundle workspace imports as ESM because the current SDK is import-only.
      const { build } = await import("esbuild")
      const adapterModule = join(scratch, "adapter.mjs")
      await symlink(resolve("node_modules"), join(scratch, "node_modules"), "dir")
      await build({
        entryPoints: [resolve("lib/ai/agent/external/runtimes/opencode/opencode-v2-client.ts")],
        outfile: adapterModule,
        bundle: true,
        platform: "node",
        format: "esm",
        packages: "external",
        logLevel: "silent",
      })
      const { OpenCodeV2ClientAdapter } = await import(pathToFileURL(adapterModule).href)
      const adapter = new OpenCodeV2ClientAdapter()
      try {
        await adapter.connect({
          id: "smoke",
          protocol: "opencode-v2",
          network: { endpoint: endpoint.url },
          metadata: {
            serverUsername: endpoint.auth?.username,
            serverPassword: endpoint.auth?.password,
          },
          defaultPermissionMode: "default",
        })
        assert.equal(await adapter.healthCheck(), true)
        const managed = await adapter.createSession({
          cwd: workspace,
          systemPrompt: "COGNIA_INSTRUCTION_MARKER",
          metadata: { model: "fixture/fixture" },
        })
        sessions.push(managed.id)
        assert.equal((await adapter.resumeSession(managed.id, { cwd: workspace })).id, managed.id)
        assert.ok(
          (await adapter.listSessions({ cwd: workspace })).some(
            (item: { sessionId: string }) => item.sessionId === managed.id
          )
        )
        await adapter
          .getSdkClient()
          .session.shell({ sessionID: managed.id, command: "printf 'cognia adapter smoke'" })
        await adapter.getSdkClient().session.wait({ sessionID: managed.id })
        const branch = await adapter.forkSession(managed.id)
        sessions.push(branch.id)
        await adapter.setSessionMode(managed.id, "plan")
        const available = adapter.getSessionModels(managed.id)?.availableModels ?? []
        assert.ok(available.length > 0, "Adapter model catalog is empty")
        await adapter.setSessionModel(managed.id, available[0].modelId)
        await adapter.setSessionModel(managed.id, "fixture/fixture")
        await adapter.setSessionMode(managed.id, "default")
        const message = (text: string): ExternalAgentMessage => ({
          id: crypto.randomUUID(),
          role: "user",
          content: [{ type: "text", text }],
          timestamp: new Date(),
        })
        const events: ExternalAgentEvent[] = []
        for await (const event of adapter.prompt(managed.id, message("SMOKE_TEXT"), {
          timeout: 20_000,
        }))
          events.push(event)
        assert.ok(
          events.some(
            (event) =>
              event.type === "message_delta" &&
              event.delta.type === "text" &&
              event.delta.text.includes("TEXT_COMPLETE")
          )
        )
        assert.ok(
          events.some(
            (event) => event.type === "thinking" && event.thinking.includes("Fixture reasoning")
          )
        )
        assert.ok(events.some((event) => event.type === "done" && event.success))
        assert.ok(
          fixture.requests.some((body) =>
            JSON.stringify(body.messages).includes("COGNIA_INSTRUCTION_MARKER")
          )
        )
        checked("adapter prompt/text/reasoning/completion/instructions through local model fixture")
        const commandEvents: ExternalAgentEvent[] = []
        for await (const event of adapter.prompt(managed.id, message("/smoke command"), {
          timeout: 20_000,
        }))
          commandEvents.push(event)
        assert.ok(commandEvents.some((event) => event.type === "done" && event.success))
        checked("adapter discovers and invokes native slash command")
        const toolEvents: ExternalAgentEvent[] = []
        for await (const event of adapter.prompt(managed.id, message("SMOKE_TOOL"), {
          timeout: 20_000,
        })) {
          toolEvents.push(event)
          if (event.type === "permission_request")
            await adapter.respondToPermission(managed.id, {
              requestId: event.request.id,
              granted: true,
            })
        }
        assert.ok(toolEvents.some((event) => event.type === "permission_request"))
        assert.ok(toolEvents.some((event) => event.type === "tool_result" && !event.isError))
        assert.ok(toolEvents.some((event) => event.type === "done" && event.success))
        checked("adapter real shell tool/permission request/reply/result")
        const deniedEvents: ExternalAgentEvent[] = []
        for await (const event of adapter.prompt(managed.id, message("SMOKE_TOOL_DENY"), {
          timeout: 20_000,
        })) {
          deniedEvents.push(event)
          if (event.type === "permission_request")
            await adapter.respondToPermission(managed.id, {
              requestId: event.request.id,
              granted: false,
              reason: "Fixture denial",
            })
        }
        assert.ok(deniedEvents.some((event) => event.type === "permission_request"))
        assert.ok(deniedEvents.some((event) => event.type === "tool_result" && event.isError))
        checked("adapter permission rejection produces failed tool result")
        const cancellation = (async () => {
          for await (const event of adapter.prompt(managed.id, message("SMOKE_CANCEL"), {
            timeout: 20_000,
          })) {
            if (event.type === "message_delta") await adapter.cancel(managed.id)
          }
        })()
        await assert.rejects(cancellation)
        const cancelDeadline = Date.now() + 3_000
        while (!fixture.cancelledConnections() && Date.now() < cancelDeadline) await delay(50)
        assert.ok(fixture.cancelledConnections() > 0, "Provider connection was not cancelled")
        checked("adapter cancellation interrupts real execution and model HTTP stream")
        await adapter.deleteSession(branch.id)
        sessions.splice(sessions.indexOf(branch.id), 1)
        await adapter.deleteSession(managed.id)
        sessions.splice(sessions.indexOf(managed.id), 1)
        checked("Cognia adapter connect/create/resume/list/fork/mode/model/delete")
      } finally {
        await adapter.disconnect()
      }
    }

    for (const id of sessions.splice(0)) await client.session.remove({ sessionID: id }, request())
    assert.equal((await client.session.list({ directory: workspace }, request())).data.length, 0)
    checked("session cleanup")
    console.log(
      JSON.stringify(
        {
          ok: true,
          cli: version,
          serviceVersion: status.version,
          checks,
          modelCount: models.data.length,
          modelPrompt: process.argv.includes("--adapter")
            ? "deterministic local model fixture; no external model or credentials"
            : "not run",
        },
        null,
        2
      )
    )
  } finally {
    eventController.abort()
    await eventTask?.catch(() => undefined)
    for (const sessionID of sessions)
      await client?.session.remove({ sessionID }, request()).catch(() => undefined)
    await Service.stop({ file: registration }).catch(() => undefined)
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM")
      await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(3_000)])
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL")
        await new Promise((resolve) => child.once("exit", resolve))
      }
    }
    await fixture.close()
    await rm(scratch, { recursive: true, force: true })
    assert.ok(child.exitCode !== null || child.signalCode !== null, "Isolated service did not stop")
    console.log("PASS isolated service/model fixture stopped and temporary state removed")
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : JSON.stringify(error))
  process.exitCode = 1
})
