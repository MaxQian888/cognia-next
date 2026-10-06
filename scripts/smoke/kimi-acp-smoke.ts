/** Native Kimi subscription and ACP acceptance through Cognia's host sandbox.
 * Default mode uses isolated unauthenticated state. --authenticated explicitly
 * opts into the local CLI login; only probe-created sessions/files are removed.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { createServer, type ServerResponse } from "node:http"
import { selectCliAgentWorkspace } from "@/cli/src/runtime/external/host-branch"
import { createAcpClientAdapter } from "@/lib/ai/agent/external/integrations/acp"
import type { ExternalAgentContent, AcpElicitationValue } from "@/types/agent/external-agent"
import { createAgentFromPreset } from "@/lib/ai/agent/external/config/presets"

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function main() {
  const authenticated = process.argv.includes("--authenticated")
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(process.cwd(), ".smoke-kimi-acp-")))
  const state = authenticated
    ? path.resolve(process.env.KIMI_CODE_HOME ?? path.join(os.homedir(), ".kimi-code"))
    : path.join(scratch, "kimi-state")
  const config = createAgentFromPreset("kimi", {
    id: `kimi-smoke-${randomUUID()}`,
    process: {
      command: "kimi",
      args: ["acp"],
      cwd: scratch,
      env: {
        KIMI_CODE_HOME: state,
        KIMI_DISABLE_TELEMETRY: "1",
        KIMI_LOOP_MAX_STEPS_PER_TURN: "12",
        KIMI_LOOP_MAX_ATTEMPTS_PER_STEP: "2",
        // An explicit empty model override prevents accidental shell BYOK use.
        KIMI_MODEL_NAME: "",
        KIMI_MODEL_API_KEY: "",
      },
    },
    timeout: 30_000,
    retryConfig: { maxRetries: 0, retryDelay: 0, exponentialBackoff: false },
  })
  check(config, "Missing Kimi preset")
  const adapter = createAcpClientAdapter()
  const ownedSessions = new Set<string>()
  const markers = {
    reply: `KIMI_OK_${randomUUID().replaceAll("-", "")}`,
    mcp: `MCP_OK_${randomUUID()}`,
  }
  const mcpScript = path.join(scratch, "mcp-probe.mjs")
  const mcpReceipt = path.join(scratch, "mcp-called.txt")
  fs.writeFileSync(
    mcpScript,
    `
import readline from 'node:readline';
import fs from 'node:fs';
readline.createInterface({input:process.stdin}).on('line', line => {
  const req=JSON.parse(line); if(req.id === undefined) return;
  let result={};
  if(req.method === 'initialize') result={protocolVersion:req.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'kimi-probe',version:'1.0.0'}};
  else if(req.method === 'tools/list') result={tools:[{name:'probe',description:'Return the Kimi integration probe marker',inputSchema:{type:'object',properties:{},additionalProperties:false}}]};
  else if(req.method === 'tools/call') {fs.writeFileSync(${JSON.stringify(mcpReceipt)},${JSON.stringify(markers.mcp)});result={content:[{type:'text',text:${JSON.stringify(markers.mcp)}}]};}
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,result})+'\\n');
});
`
  )
  const networkReceipts = new Set<string>()
  const sseStreams = new Map<string, ServerResponse>()
  const networkMcp = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1")
    if (request.method === "GET" && url.pathname === "/sse") {
      const id = randomUUID()
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" })
      sseStreams.set(id, response)
      response.write(`event: endpoint\ndata: /sse-message?sessionId=${id}\n\n`)
      request.on("close", () => sseStreams.delete(id))
      return
    }
    if (request.method !== "POST") {
      response.writeHead(405).end()
      return
    }
    let body = ""
    for await (const chunk of request) body += chunk
    const rpc = JSON.parse(body)
    const transport = url.pathname === "/sse-message" ? "sse" : "http"
    let result: unknown = {}
    if (rpc.method === "initialize")
      result = {
        protocolVersion: rpc.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: `kimi-${transport}-probe`, version: "1.0.0" },
      }
    if (rpc.method === "tools/list")
      result = {
        tools: [
          {
            name: "probe",
            description: `Return the Kimi ${transport} integration marker`,
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
          },
        ],
      }
    if (rpc.method === "tools/call") {
      networkReceipts.add(transport)
      result = { content: [{ type: "text", text: `KIMI_${transport.toUpperCase()}_OK` }] }
    }
    if (transport === "sse") {
      response.writeHead(202).end()
      if (rpc.id !== undefined)
        sseStreams
          .get(url.searchParams.get("sessionId") ?? "")
          ?.write(
            `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result })}\n\n`
          )
    } else if (rpc.id === undefined) response.writeHead(202).end()
    else
      response
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }))
  })
  await new Promise<void>((resolve) => networkMcp.listen(0, "127.0.0.1", resolve))
  const address = networkMcp.address()
  check(address && typeof address !== "string", "MCP fixture did not start")
  const mcpServers = [
    { name: "kimi-probe", command: process.execPath, args: [mcpScript], env: [] },
    {
      type: "http" as const,
      name: "kimi-http-probe",
      url: `http://127.0.0.1:${address.port}/mcp`,
      headers: [],
    },
    {
      type: "sse" as const,
      name: "kimi-sse-probe",
      url: `http://127.0.0.1:${address.port}/sse`,
      headers: [],
    },
  ]
  const summaries: Record<string, unknown> = {}
  async function turn(
    sessionId: string,
    text: string,
    allowPermissions = false,
    image?: string,
    extraContent: ExternalAgentContent[] = []
  ) {
    let reply = ""
    let stopReason: string | undefined
    const events: Record<string, number> = {}
    for await (const event of adapter.prompt(
      sessionId,
      {
        id: randomUUID(),
        role: "user",
        content: [
          { type: "text", text },
          ...extraContent,
          ...(image
            ? [
                {
                  type: "image" as const,
                  source: { type: "base64" as const, data: image, mediaType: "image/png" },
                },
              ]
            : []),
        ],
        timestamp: new Date(),
      },
      { timeout: 150_000 }
    )) {
      events[event.type] = (events[event.type] ?? 0) + 1
      if (event.type === "message_delta" && event.delta.type === "text") reply += event.delta.text
      if (event.type === "done") stopReason = event.stopReason
      if (event.type === "permission_request")
        await adapter.respondToPermission(sessionId, {
          requestId: event.request.requestId ?? event.request.id,
          granted: allowPermissions,
          scope: "once",
        })
      if (event.type === "elicitation_request") {
        check(event.request.mode === "form", "Unexpected URL elicitation in local probe")
        const content: Record<string, AcpElicitationValue> = {}
        for (const [name, property] of Object.entries(
          event.request.requestedSchema?.properties ?? {}
        )) {
          const choices = property.type === "array" ? property.items : property
          const first = choices?.oneOf?.[0]?.const ?? choices?.enum?.[0]
          check(first, "Probe question must offer explicit choices")
          content[name] = property.type === "array" ? [first] : first
        }
        await adapter.respondToElicitation({
          requestId: event.request.id,
          action: "accept",
          content,
        })
      }
      if (event.type === "error") throw new Error(`Kimi turn error: ${JSON.stringify(event)}`)
    }
    return { reply, stopReason, events }
  }
  try {
    selectCliAgentWorkspace(scratch)
    await adapter.connect(config)
    const init = adapter.getAcpInitializationMetadata()
    check(init.protocolVersion === 1, "Kimi did not negotiate ACP v1")
    check(init.agentInfo?.name === "Kimi Code CLI", "Unexpected ACP implementation")
    const auth = adapter.getAuthMethods().find((method) => method.id === "login")
    check(auth?.type === "terminal", "Kimi terminal subscription login missing")
    check(auth.env?.KIMI_CODE_HOME === state, "Login does not target the selected CLI state")
    check(init.agentCapabilities?.loadSession, "Session load missing")
    check(init.agentCapabilities?.promptCapabilities?.image, "Image support missing")
    check(init.agentCapabilities?.mcpCapabilities?.http, "HTTP MCP support missing")
    if (!authenticated) {
      let refused = false
      try {
        await adapter.createSession({ cwd: scratch, mcpServers: [] })
      } catch (error) {
        refused = /auth/i.test(error instanceof Error ? error.message : String(error))
      }
      check(refused, "Kimi must refuse sessions without credentials")
      await adapter.disconnect()
      // Synthetic credentials exercise native config/lifecycle, never a model request.
      Object.assign(config.process!.env!, {
        KIMI_MODEL_NAME: "fixture",
        KIMI_MODEL_PROVIDER_TYPE: "openai",
        KIMI_MODEL_BASE_URL: "http://127.0.0.1:1/v1",
        KIMI_MODEL_API_KEY: "synthetic-fixture",
      })
      await adapter.connect(config)
      summaries.authenticationRequired = true
    }
    const session = await adapter.createSession({
      cwd: scratch,
      mcpServers,
    })
    ownedSessions.add(session.id)
    for (const mode of [
      "plan",
      "acceptEdits",
      "dontAsk",
      "bypassPermissions",
      "default",
    ] as const) {
      await adapter.setSessionMode(session.id, mode)
      check(adapter.getSession(session.id)?.permissionMode === mode, `Mode failed: ${mode}`)
    }
    const options = adapter.getConfigOptions(session.id)
    const model = options?.find((option) => option.id === "model")
    check(model, "Model selector missing")
    await adapter.setConfigOption(session.id, model.id, model.currentValue)
    const thinking = options?.find((option) => option.id === "thinking")
    check(thinking, "Thinking selector missing")
    await adapter.setConfigOption(session.id, thinking.id, thinking.currentValue)
    summaries.configOptions = options?.map((option) => ({ id: option.id, type: option.type }))
    if (authenticated) {
      const response = await turn(
        session.id,
        `Do not use any tools. Reply with exactly: ${markers.reply}`
      )
      check(response.reply.trim() === markers.reply, `Unexpected model reply: ${response.reply}`)
      check(response.stopReason === "end_turn", `Unexpected stop reason: ${response.stopReason}`)
      summaries.reply = response
      const tools = await turn(
        session.id,
        `Call the MCP kimi-probe probe tool once. Write exactly its returned marker to the relative file result.txt in the current working directory, then read that file to verify it. Do not access other directories, use network, or run unrelated commands. Report the verified marker.`,
        true
      )
      check(fs.readFileSync(mcpReceipt, "utf8") === markers.mcp, "Native MCP tool was not called")
      check(
        fs.readFileSync(path.join(scratch, "result.txt"), "utf8").trim() === markers.mcp,
        "Native file edit failed"
      )
      check((tools.events.permission_request ?? 0) > 0, "Native manual approval was not exercised")
      check(tools.stopReason === "end_turn", "Tool turn did not finish")
      summaries.tools = tools
      // Fixed 64x64 red PNG: model must receive the image, not just a text marker.
      const image = await turn(
        session.id,
        "Do not use tools. What solid color is the attached image? Reply with only the lowercase English color.",
        false,
        "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAb0lEQVR4nO3PAQkAAAyEwO9feoshgnABdLep8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3IPanc8OLDQitxAAAAAElFTkSuQmCC"
      )
      check(
        image.reply.trim().toLowerCase() === "red",
        `Image understanding failed: ${image.reply}`
      )
      summaries.image = image
      const resourceMarker = `RESOURCE_${randomUUID()}`
      const resource = await turn(
        session.id,
        "Do not use tools. Reply with exactly the text in the attached text resource.",
        false,
        undefined,
        [
          {
            type: "resource",
            resource: {
              uri: "cognia-probe://resource",
              mimeType: "text/plain",
              text: resourceMarker,
            },
          },
        ]
      )
      check(resource.reply.trim() === resourceMarker, "Embedded text resource was lost")
      summaries.resource = resource
      const shellMarker = `SHELL_${randomUUID()}`
      const shell = await turn(
        session.id,
        `Use the Shell tool once to execute exactly this command:\nprintf '%s' '${shellMarker}' > shell-result.txt\nThen reply with ${shellMarker}. Do not use file editing tools, access other directories or run any other command.`,
        true
      )
      check(
        fs.readFileSync(path.join(scratch, "shell-result.txt"), "utf8") === shellMarker,
        "Native Shell execution failed"
      )
      summaries.shell = shell
      const question = await turn(
        session.id,
        "Use AskUserQuestion now to ask two questions: one single choice (Tests or Docs), one multiple choice (Alpha or Beta). Wait for both answers, then reply with the selected labels. Do not use other tools.",
        true
      )
      check(
        (question.events.elicitation_request ?? 0) > 0,
        "Native question form was not exercised"
      )
      summaries.question = question
      const denySession = await adapter.createSession({ cwd: scratch, mcpServers })
      ownedSessions.add(denySession.id)
      fs.rmSync(mcpReceipt, { force: true })
      const denied = await turn(
        denySession.id,
        "Call the kimi-probe MCP probe tool once. If permission is denied, stop immediately without retrying or using other tools.",
        false
      )
      check((denied.events.permission_request ?? 0) > 0, "Native denial was not exercised")
      check(!fs.existsSync(mcpReceipt), "Denied MCP tool still executed")
      summaries.denial = denied
      await adapter.setSessionMode(denySession.id, "dontAsk")
      const silentDenial = await turn(
        denySession.id,
        "Call the kimi-probe MCP probe tool once. If permission is denied, stop immediately without retrying or using other tools.",
        false
      )
      check(
        (silentDenial.events.permission_request ?? 0) === 0,
        "dontAsk surfaced a permission question"
      )
      check(!fs.existsSync(mcpReceipt), "dontAsk executed an unallowlisted MCP tool")
      summaries.dontAsk = silentDenial
      await adapter.deleteSession(denySession.id)
      ownedSessions.delete(denySession.id)
      const compact = await turn(session.id, "/compact", true)
      check(compact.stopReason === "end_turn", "Native compaction trigger was not acknowledged")
      check(!/unknown|failed|error/i.test(compact.reply), `Compaction failed: ${compact.reply}`)
      summaries.compaction = compact
      const cancelSession = await adapter.createSession({ cwd: scratch, mcpServers })
      ownedSessions.add(cancelSession.id)
      let cancelled = false
      let cancellationStopReason: string | undefined
      let stopPolling = false
      const cancellation = (async () => {
        const deadline = Date.now() + 60_000
        while (!stopPolling && Date.now() < deadline) {
          if (fs.existsSync(path.join(scratch, "cancel-started.txt"))) {
            await adapter.cancel(cancelSession.id)
            cancelled = true
            return
          }
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
      })()
      try {
        for await (const event of adapter.prompt(
          cancelSession.id,
          {
            id: randomUUID(),
            role: "user",
            timestamp: new Date(),
            content: [
              {
                type: "text",
                text: "Use Shell once to run exactly: printf started > cancel-started.txt; sleep 30; printf finished > cancel-finished.txt. Do not use other tools or change other files.",
              },
            ],
          },
          { timeout: 90_000 }
        )) {
          if (event.type === "permission_request")
            await adapter.respondToPermission(cancelSession.id, {
              requestId: event.request.requestId ?? event.request.id,
              granted: true,
              scope: "once",
            })
          if (event.type === "done") cancellationStopReason = event.stopReason
          if (event.type === "error")
            throw new Error(`Cancellation probe error: ${JSON.stringify(event)}`)
        }
      } finally {
        stopPolling = true
        await cancellation
      }
      check(cancelled, "No running Shell tool was cancelled")
      check(
        cancellationStopReason === "cancelled",
        `Cancellation stop reason: ${cancellationStopReason}`
      )
      check(
        !fs.existsSync(path.join(scratch, "cancel-finished.txt")),
        "Cancelled Shell still finished"
      )
      summaries.inFlightCancellation = {
        stopReason: cancellationStopReason,
        toolStarted: true,
        toolFinished: false,
      }
      await adapter.deleteSession(cancelSession.id)
      ownedSessions.delete(cancelSession.id)
    }
    check(
      (await adapter.listSessions({ cwd: scratch })).some(
        (entry) => entry.sessionId === session.id
      ),
      "Saved session missing"
    )
    const fork = await adapter.forkSession(session.id, { cwd: scratch, mcpServers })
    ownedSessions.add(fork.id)
    let forkMcp = ""
    for (let attempt = 0; attempt < 30; attempt++) {
      forkMcp = (await turn(fork.id, "/mcp")).reply
      if (
        mcpServers.every((server) =>
          new RegExp(`${server.name} .*connected.*1 tools`).test(forkMcp)
        )
      )
        break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    check(
      mcpServers.every((server) => new RegExp(`${server.name} .*connected.*1 tools`).test(forkMcp)),
      `Fork lost MCP tools: ${forkMcp}`
    )
    summaries.forkMcp = forkMcp
    if (authenticated) {
      fs.rmSync(mcpReceipt, { force: true })
      const forkTools = await turn(
        fork.id,
        "Call the kimi-probe MCP probe tool once and reply with its exact returned marker. Do not use any other tools.",
        true
      )
      check(fs.readFileSync(mcpReceipt, "utf8") === markers.mcp, "Fork did not call MCP tool")
      check(forkTools.reply.includes(markers.mcp), "Fork did not return tool marker")
      summaries.forkToolCall = forkTools
      const networkTools = await turn(
        fork.id,
        "Call both kimi-http-probe and kimi-sse-probe MCP probe tools once each. Reply with both returned markers. Do not use other tools.",
        true
      )
      check(
        networkReceipts.has("http") && networkReceipts.has("sse"),
        "HTTP/SSE tools were not both called"
      )
      check(
        networkTools.reply.includes("KIMI_HTTP_OK") && networkTools.reply.includes("KIMI_SSE_OK"),
        "HTTP/SSE markers missing"
      )
      summaries.httpSseToolCalls = networkTools
    }
    await adapter.closeSession(fork.id)
    await adapter.deleteSession(fork.id)
    ownedSessions.delete(fork.id)
    const deferredFork = await adapter.forkSession(session.id, { cwd: scratch })
    ownedSessions.add(deferredFork.id)
    const preparedFork = await adapter.prepareForkSessionForExecution(deferredFork.id, {
      cwd: scratch,
      mcpServers,
    })
    check(
      preparedFork?.id === deferredFork.id,
      "GUI fork was not prepared with fresh tool bindings"
    )
    let deferredMcp = ""
    for (let attempt = 0; attempt < 30; attempt++) {
      deferredMcp = (await turn(deferredFork.id, "/mcp")).reply
      if (
        mcpServers.every((server) =>
          new RegExp(`${server.name} .*connected.*1 tools`).test(deferredMcp)
        )
      )
        break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    check(
      mcpServers.every((server) =>
        new RegExp(`${server.name} .*connected.*1 tools`).test(deferredMcp)
      ),
      `GUI fork lost MCP tools: ${deferredMcp}`
    )
    summaries.deferredForkMcp = deferredMcp
    await adapter.deleteSession(deferredFork.id)
    ownedSessions.delete(deferredFork.id)
    await adapter.disconnect()
    await adapter.connect(config)
    await adapter.loadSession(session.id, {
      cwd: scratch,
      mcpServers,
    })
    await adapter.closeSession(session.id)
    await adapter.resumeSession(session.id, {
      cwd: scratch,
      mcpServers,
    })
    await adapter.deleteSession(session.id)
    // Native 2.1.1 can publish an in-flight pre-delete index scan. Verify
    // eventual disappearance, retaining ownership until cleanup is confirmed.
    const deleteDeadline = Date.now() + 75_000
    let deletedVisible = true
    while (Date.now() < deleteDeadline) {
      deletedVisible = (await adapter.listSessions({ cwd: scratch })).some(
        (entry) => entry.sessionId === session.id
      )
      if (!deletedVisible) break
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    check(!deletedVisible, "Deleted probe session still listed after index reconciliation")
    ownedSessions.delete(session.id)
    console.log(
      JSON.stringify(
        {
          ok: true,
          version: init.agentInfo.version,
          protocolVersion: init.protocolVersion,
          sandboxedConnection: true,
          authenticated,
          modes: true,
          listForkCloseLoadResumeDelete: true,
          advertisedCapabilities: init.agentCapabilities,
          ...summaries,
        },
        null,
        2
      )
    )
  } finally {
    for (const id of ownedSessions) await adapter.deleteSession(id).catch(() => undefined)
    await adapter.disconnect()
    selectCliAgentWorkspace(process.cwd())
    networkMcp.closeAllConnections()
    await new Promise<void>((resolve) => networkMcp.close(() => resolve()))
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
