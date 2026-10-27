/** Real Copilot CLI + Cognia ACP/host acceptance, with a loopback provider or opt-in live BYOK. */
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createServer, type ServerResponse } from "node:http"
import { execFileSync } from "node:child_process"
import { createAcpClientAdapter } from "@/lib/ai/agent/external/integrations/acp"
import { createAgentFromPreset } from "@/lib/ai/agent/external/config/presets"
import { selectCliAgentWorkspace } from "@/cli/src/runtime/external/host-branch"
import { copilotCliSessionSource } from "@/lib/session-import/adapters/copilot-cli"

interface ChatRequest {
  model: string
  messages: Array<{ role: string; content?: unknown }>
  tools?: Array<{ function: { name: string; parameters: Record<string, unknown> } }>
}

async function main() {
  assert.equal(Number(process.versions.node.split(".")[0]), 26, "Use Node 26 for this smoke")
  const root = path.resolve(".cache/copilot-cli-acceptance")
  fs.mkdirSync(root, { recursive: true })
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cognia-copilot-")))
  const home = path.join(workspace, ".copilot")
  fs.mkdirSync(home)
  const githubAuth = process.argv.includes("--github-auth")
  const live = githubAuth || process.argv.includes("--live-provider")
  if (live && !githubAuth)
    assert.ok(process.env.DEEPSEEK_API_KEY, "Set DEEPSEEK_API_KEY for the live BYOK lane")
  // Only this explicit lane reads an existing credential. Never print or persist it.
  const githubToken = githubAuth
    ? execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim()
    : undefined
  let scenario = "text"
  const requests: ChatRequest[] = []
  const fixtureErrors: string[] = []
  const streams = new Set<ServerResponse>()
  const server = createServer(async (request, response) => {
    streams.add(response)
    response.once("close", () => streams.delete(response))
    try {
      let raw = ""
      for await (const chunk of request) raw += chunk
      if (request.url === "/mcp") {
        if (request.method !== "POST") {
          response.writeHead(405).end()
          return
        }
        const rpc = JSON.parse(raw) as {
          id?: number | string
          method: string
          params?: { protocolVersion?: string }
        }
        if (rpc.id === undefined) {
          response.writeHead(202).end()
          return
        }
        let result: unknown = {}
        if (rpc.method === "initialize")
          result = {
            protocolVersion: rpc.params?.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "cognia-smoke", version: "1" },
          }
        else if (rpc.method === "tools/list")
          result = {
            tools: [
              {
                name: "verify_session",
                description: "Return this disposable session marker",
                inputSchema: { type: "object", properties: {} },
                annotations: { readOnlyHint: true },
              },
            ],
          }
        else if (rpc.method === "tools/call") {
          fs.appendFileSync(path.join(workspace, "mcp.calls"), "called\n")
          result = { content: [{ type: "text", text: "MCP_SESSION_OK" }] }
        }
        response
          .writeHead(200, { "Content-Type": "application/json" })
          .end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }))
        return
      }
      assert.equal(request.url, "/v1/chat/completions")
      const body = JSON.parse(raw) as ChatRequest
      requests.push(body)
      assert.equal(body.model, "cognia-copilot-smoke")
      const tools = body.tools?.map((tool) => tool.function.name) ?? []
      fs.writeFileSync(
        path.join(root, "provider-shape.json"),
        JSON.stringify({ tools: body.tools }, null, 2)
      )
      response.writeHead(200, { "Content-Type": "text/event-stream" })
      const send = (delta: unknown, reason: string | null = null) =>
        response.write(
          `data: ${JSON.stringify({
            id: `completion-${requests.length}`,
            object: "chat.completion.chunk",
            created: 1,
            model: body.model,
            choices: [{ index: 0, delta, finish_reason: reason }],
          })}\n\n`
        )
      const lastUser = body.messages.findLastIndex((message) => message.role === "user")
      const completed = body.messages.slice(lastUser + 1).some((message) => message.role === "tool")
      fs.appendFileSync(
        path.join(root, "provider-turns.jsonl"),
        JSON.stringify({
          scenario,
          completed,
          lastUser: body.messages[lastUser]?.content,
          roles: body.messages.map((message) => message.role),
        }) + "\n"
      )
      if (scenario === "mcp" && !completed) {
        const name = tools.find((tool) => tool.includes("verify_session"))
        assert.ok(name, "Session MCP tool was not exposed")
        send({
          tool_calls: [
            { index: 0, id: "smoke-mcp", type: "function", function: { name, arguments: "{}" } },
          ],
        })
        send({}, "tool_calls")
      } else if ((scenario === "approve" || scenario === "reject") && !completed) {
        const file = path.join(workspace, scenario === "approve" ? "approved.txt" : "denied.txt")
        const name = tools.includes("create") ? "create" : "bash"
        assert.ok(tools.includes(name), "Native file/shell tool was not exposed")
        const args =
          name === "create"
            ? { path: file, file_text: "COPILOT_TOOL_OK\n" }
            : {
                command: `printf 'COPILOT_TOOL_OK\\n' > '${file}'`,
                description: "Write the disposable smoke file",
              }
        send({
          tool_calls: [
            {
              index: 0,
              id: `smoke-${scenario}`,
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        })
        send({}, "tool_calls")
      } else if (scenario === "cancel") {
        send({ content: "CANCEL_READY" })
        return
      } else {
        if (scenario === "mcp")
          assert.ok(
            JSON.stringify(body.messages).includes("MCP_SESSION_OK"),
            "MCP result did not reach the provider"
          )
        if (scenario === "resume")
          assert.ok(
            JSON.stringify(body.messages).includes("COPILOT_SMOKE_OK"),
            "Native resume lost the prior turn"
          )
        send({ role: "assistant", content: scenario === "resume" ? "RESUMED_" : "COPILOT_" })
        send({ content: scenario === "resume" ? "OK" : "SMOKE_OK" })
        send({}, "stop")
      }
      response.end("data: [DONE]\n\n")
    } catch (error) {
      fixtureErrors.push(error instanceof Error ? error.message : String(error))
      if (!response.headersSent) response.writeHead(500, { "Content-Type": "application/json" })
      response.end(
        JSON.stringify({
          error: { message: error instanceof Error ? error.message : String(error) },
        })
      )
    }
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert.ok(address && typeof address === "object")
  const endpoint = live ? "https://api.deepseek.com/v1" : `http://127.0.0.1:${address.port}/v1`
  const config = createAgentFromPreset("copilot-cli", {
    id: "copilot-acceptance",
    process: {
      command: "copilot",
      args: [
        "--acp",
        "--stdio",
        "--disable-builtin-mcps",
        "--no-auto-update",
        "--disable-client-telemetry",
      ],
      cwd: workspace,
      env: {
        COPILOT_HOME: home,
        ...(githubAuth
          ? {}
          : {
              COPILOT_PROVIDER_TYPE: "openai",
              COPILOT_PROVIDER_BASE_URL: endpoint,
              COPILOT_PROVIDER_WIRE_API: "completions",
              COPILOT_PROVIDER_API_KEY: live ? process.env.DEEPSEEK_API_KEY! : "synthetic-fixture",
              COPILOT_MODEL: live ? "deepseek-flash" : "cognia-copilot-smoke",
              COPILOT_OFFLINE: "true",
            }),
        COPILOT_AUTO_UPDATE: "false",
        COPILOT_GITHUB_TOKEN: githubToken ?? "cognia-gateway-task-no-github-auth",
        GH_TOKEN: githubToken ?? "cognia-gateway-task-no-github-auth",
        GITHUB_TOKEN: githubToken ?? "cognia-gateway-task-no-github-auth",
      },
    },
    timeout: 45_000,
    retryConfig: { maxRetries: 0, retryDelay: 0, exponentialBackoff: false },
  })
  assert.ok(config)
  let adapter = createAcpClientAdapter()
  let sessionId = ""
  let stage = "connect"
  const report: Record<string, unknown> = {
    node: process.version,
    provider: githubAuth ? "github-native-live" : live ? "deepseek-live" : "loopback-fixture",
    workspaceIsolated: true,
  }
  async function prompt(text: string, targetScenario = "text") {
    scenario = targetScenario
    const events: Record<string, number> = {}
    const approvals: Array<{ granted: boolean; name: string }> = []
    let reply = ""
    let stopReason: string | undefined
    for await (const event of adapter.prompt(
      sessionId,
      {
        id: `smoke-${Date.now()}`,
        role: "user",
        content: [{ type: "text", text }],
        timestamp: new Date(),
      },
      { timeout: live ? 90_000 : 20_000 }
    )) {
      events[event.type] = (events[event.type] ?? 0) + 1
      if (event.type === "message_delta" && event.delta.type === "text") {
        reply += event.delta.text
        if (targetScenario === "cancel") await adapter.cancel(sessionId)
      }
      if (event.type === "permission_request") {
        // This is the smoke's explicit human-equivalent approval, not an automatic allow-list.
        const input = event.request.rawInput ?? event.request.inputPreview
        const requestedPath = input?.path ?? input?.file_path ?? event.request.locations?.[0]?.path
        const granted =
          (targetScenario === "approve" &&
            requestedPath === path.join(workspace, "approved.txt")) ||
          (targetScenario === "mcp" && /verify_session/.test(event.request.toolInfo.name))
        approvals.push({ granted, name: event.request.toolInfo.name })
        await adapter.respondToPermission(sessionId, {
          requestId: event.request.requestId ?? event.request.id,
          granted,
          scope: "once",
        })
      }
      if (event.type === "error") throw new Error(event.error)
      if (event.type === "done") stopReason = event.stopReason
    }
    assert.equal(fixtureErrors.length, 0, fixtureErrors.join("; "))
    return { reply, events, approvals, stopReason }
  }
  try {
    selectCliAgentWorkspace(workspace)
    await adapter.connect(config)
    const init = adapter.getAcpInitializationMetadata()
    assert.equal(init.agentInfo?.version, "1.0.103")
    assert.equal(init.protocolVersion, 1)
    report.version = init.agentInfo.version
    report.authMethods = adapter
      .getAuthMethods()
      .map((method) => ({ id: method.id, type: method.type }))
    const mcpServers = live
      ? []
      : [
          {
            type: "http" as const,
            name: "cognia-smoke",
            url: `http://127.0.0.1:${address.port}/mcp`,
            headers: [],
          },
        ]
    const session = await adapter.createSession({ cwd: workspace, mcpServers })
    sessionId = session.id
    assert.equal(
      session.permissionMode,
      "default",
      "Copilot Agent mode must use Cognia's default approval policy"
    )
    stage = "modes"
    await adapter.setSessionMode(sessionId, "plan")
    assert.equal(adapter.getSession(sessionId)?.permissionMode, "plan")
    await adapter.setSessionMode(sessionId, "default")
    await adapter.setConfigOption(sessionId, "allow_all", "on")
    assert.equal(adapter.getSession(sessionId)?.permissionMode, "bypassPermissions")
    await adapter.setSessionMode(sessionId, "default")
    assert.equal(
      adapter.getConfigOptions(sessionId)?.find((option) => option.id === "allow_all")
        ?.currentValue,
      "off"
    )
    assert.equal(adapter.getSession(sessionId)?.permissionMode, "default")
    report.modes = true
    stage = "text"
    const text = await prompt(
      "Reply with exactly COPILOT_SMOKE_OK. Do not use tools, read files, or modify anything."
    )
    assert.ok(text.reply.includes("COPILOT_SMOKE_OK"), JSON.stringify(text))
    assert.ok(text.events.message_delta)
    report.text = text
    if (!live) {
      stage = "approve"
      const approved = await prompt(
        "COGNIA_SMOKE_APPROVE: Write the disposable approved.txt fixture.",
        "approve"
      )
      report.approval = approved
      assert.ok(
        approved.approvals.some((approval) => approval.granted),
        "Expected bounded write approval was not granted"
      )
      assert.equal(
        fs.readFileSync(path.join(workspace, "approved.txt"), "utf8"),
        "COPILOT_TOOL_OK\n"
      )
      report.approval = approved
      stage = "reject"
      const rejected = await prompt(
        "COGNIA_SMOKE_REJECT: Do not write denied.txt if approval is refused.",
        "reject"
      )
      assert.ok(
        rejected.approvals.some((approval) => !approval.granted),
        "Denied tool did not reach the host broker"
      )
      assert.equal(fs.existsSync(path.join(workspace, "denied.txt")), false)
      report.rejection = rejected
      report.mcpStatus = await prompt("/mcp")
      stage = "mcp"
      report.mcp = await prompt("COGNIA_SMOKE_MCP: Call verify_session once.", "mcp")
      assert.equal(fs.readFileSync(path.join(workspace, "mcp.calls"), "utf8"), "called\n")
      stage = "cancel"
      report.cancellation = await prompt("COGNIA_SMOKE_CANCEL", "cancel")
      assert.equal((report.cancellation as { stopReason?: string }).stopReason, "cancelled")
      stage = "recover"
      const recovered = await prompt("Reply COPILOT_SMOKE_OK after cancellation.")
      assert.ok(recovered.reply.includes("COPILOT_SMOKE_OK"))
      report.cancelRecovery = true
    }
    stage = "close-list"
    await adapter.closeSession(sessionId)
    const listed = await adapter.listSessions({ cwd: workspace })
    assert.ok(
      listed.some((item) => item.sessionId === sessionId),
      "Closed session missing from persisted session list"
    )
    await adapter.disconnect()
    stage = "cross-process-resume"
    adapter = createAcpClientAdapter()
    await adapter.connect(config)
    const restored = await adapter.resumeSession(sessionId, { cwd: workspace, mcpServers })
    assert.equal(restored.id, sessionId)
    assert.equal(restored.permissionMode, "default")
    const resumed = await prompt(
      "Reply with exactly RESUMED_OK without tools. Remember our earlier marker.",
      "resume"
    )
    assert.ok(resumed.reply.includes("RESUMED_OK"))
    report.resume = resumed
    await adapter.closeSession(sessionId)
    await adapter.disconnect()
    stage = "history-import"
    const artifacts = fs
      .readdirSync(home, { recursive: true })
      .filter((file): file is string => typeof file === "string" && file.endsWith("events.jsonl"))
    const artifact = artifacts.find((file) => file.includes(sessionId))
    assert.ok(artifact, "Copilot did not persist session events.jsonl")
    const content = fs.readFileSync(path.join(home, artifact), "utf8")
    fs.writeFileSync(
      path.join(
        root,
        githubAuth ? "github-events.jsonl" : live ? "live-events.jsonl" : "events.jsonl"
      ),
      content,
      { mode: 0o600 }
    )
    const input = {
      home: "",
      fs: {
        exists: async () => false,
        readDir: async () => [],
        stat: async () => ({ size: content.length, isFile: true }),
        readTextFile: async () => content,
      },
      pickedFiles: [{ name: "events.jsonl", path: path.join(home, artifact), content }],
    }
    const imported = await copilotCliSessionSource.listSessions(input)
    assert.equal(imported.length, 1)
    assert.equal(imported[0].ref.originalSessionId, sessionId)
    const graph = await copilotCliSessionSource.parseGraph!(imported[0].ref, input)
    const conversation = graph.nodes[0].conversation
    if (!live) assert.equal(conversation.session.model, "cognia-copilot-smoke")
    const serialized = JSON.stringify(conversation.messages)
    assert.ok(
      serialized.includes("COPILOT_SMOKE_OK") && serialized.includes("RESUMED_OK"),
      "Import lost assistant turns"
    )
    assert.equal(conversation.session.importRuntimeBinding?.nativeSessionId, sessionId)
    if (!live)
      assert.ok(
        conversation.messages
          .flatMap((message) => message.parts)
          .some((part) => "toolCallId" in part && part.state === "output-available"),
        "Import lost completed tools"
      )
    const scanInput = {
      home: workspace,
      fs: {
        exists: async (file: string) => fs.existsSync(file),
        readDir: async (directory: string) => fs.readdirSync(directory),
        readDirEntries: async (directory: string) =>
          fs
            .readdirSync(directory, { withFileTypes: true })
            .map((entry) => ({ name: entry.name, isFile: entry.isFile() })),
        stat: async (file: string) => {
          const stat = fs.statSync(file)
          return { size: stat.size, isFile: stat.isFile() }
        },
        readTextFile: async (file: string) => fs.readFileSync(file, "utf8"),
      },
    }
    const scanned = await copilotCliSessionSource.listSessions(scanInput)
    assert.ok(
      scanned.some((item) => item.ref.originalSessionId === sessionId),
      "Filesystem auto-scan lost the persisted session"
    )
    report.history = {
      messageCount: conversation.messages.length,
      eventCount: content.trim().split("\n").length,
      resumeBinding: true,
      filesystemScan: true,
    }
    report.ok = true
  } catch (error) {
    report.failedStage = stage
    report.error = error instanceof Error ? error.message : String(error)
    throw error
  } finally {
    await adapter.disconnect()
    for (const stream of streams) stream.destroy()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    selectCliAgentWorkspace(process.cwd())
    fs.rmSync(workspace, { recursive: true, force: true })
    fs.writeFileSync(
      path.join(
        root,
        githubAuth ? "github-report.json" : live ? "live-report.json" : "report.json"
      ),
      JSON.stringify(report, null, 2)
    )
    console.log(JSON.stringify(report, null, 2))
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
