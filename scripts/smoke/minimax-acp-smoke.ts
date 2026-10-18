/** Real mcode ACP through Cognia's host sandbox, with a local synthetic model.
 * No cloud credential or user state is read. App Server/extensions are unused.
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { createServer, type ServerResponse } from "node:http"
import { spawn, spawnSync } from "node:child_process"
import {
  installCliExternalAgentHost,
  selectCliAgentWorkspace,
} from "@/cli/src/runtime/external/host-branch"
import {
  createAcpClientAdapter,
  createAcpClientDeps,
  isolateNativeAcp,
} from "@/lib/ai/agent/external/integrations/acp"
import { createAgentFromPreset } from "@/lib/ai/agent/external/config/presets"
import { MiniMaxAcpAdapter } from "@cognia/agent-acp/minimax-adapter"
import type { AcpPermissionMode, ExternalAgentContent } from "@/types/agent/external-agent"

type Completion = {
  messages: Array<{ role: string; content: unknown }>
  tools?: Array<{ function: { name: string; parameters: unknown } }>
  stream?: boolean
}

async function main() {
  const uninstallHost = installCliExternalAgentHost()
  const originalCwd = process.cwd()
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(originalCwd, ".smoke-minimax-acp-")))
  const state = path.join(scratch, "state")
  const command = process.env.COGNIA_MINIMAX_MCODE ?? "mcode"
  const originalPath = process.env.PATH
  if (path.isAbsolute(command)) process.env.PATH = `${path.dirname(command)}:${originalPath ?? ""}`
  process.env.COGNIA_EXTERNAL_AGENT_LAUNCHER ??= path.join(
    originalCwd,
    "target/debug/cognia-external-agent-launcher"
  )
  const env = {
    ...process.env,
    MINIMAX_DATA_DIR: state,
    MAVIS_DATA_DIR: state,
    MCODE_PROVIDER_API_KEY: "synthetic-local-fixture",
  }
  const requests: string[] = []
  let receivedImage = false
  const requestShapes: unknown[] = []
  let acpImageSent = false
  const held = new Set<ServerResponse>()
  const server = createServer(async (request, response) => {
    try {
      let raw = ""
      for await (const chunk of request) raw += chunk
      const body = JSON.parse(raw) as Completion
      const users = body.messages.filter((m) => m.role === "user")
      const text = JSON.stringify(users.at(-1)?.content ?? "")
      const marker = text.match(/SMOKE:(\w+)/)?.[1] ?? "plain"
      if (JSON.stringify(body.messages).includes("data:image/")) receivedImage = true
      requestShapes.push(
        body.messages
          .filter((m) => m.role === "user")
          .map((m) => ({
            type: typeof m.content,
            parts: Array.isArray(m.content) ? m.content.map((p: { type?: string }) => p.type) : [],
          }))
      )
      const tools = body.tools ?? []
      requests.push(marker)
      const afterTool = body.messages.at(-1)?.role === "tool"
      if (marker === "hold" && !afterTool) {
        held.add(response)
        response.on("close", () => held.delete(response))
        return
      }
      let tool: NonNullable<Completion["tools"]>[number] | undefined
      let args: Record<string, unknown> = {}
      if (!afterTool && marker === "edit") {
        tool = tools.find((t) => /^(write|Write)$/i.test(t.function.name))
        args = {
          path: path.join(scratch, text.includes("PLAN_TARGET") ? "plan.txt" : "written.txt"),
          content: "MINIMAX_LOCAL_OK\n",
        }
      }
      if (!afterTool && marker.startsWith("shell")) {
        tool = tools.find((t) => /^(bash|exec)$/i.test(t.function.name))
        args = {
          command:
            marker === "shell_full"
              ? "python3 -c \"open('shell.txt','w').write('MINIMAX_SHELL_OK')\""
              : `node -e "require('fs').writeFileSync('${marker === "shell_sibling" ? "sibling.txt" : "shell.txt"}','MINIMAX_SHELL_OK')"`,
          description: "Synthetic smoke shell probe",
        }
      }
      if (!afterTool && marker === "mcp") tool = tools.find((t) => /probe/.test(t.function.name))
      const message = tool
        ? {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: `call_${randomUUID().replaceAll("-", "")}`,
                type: "function",
                function: { name: tool.function.name, arguments: JSON.stringify(args) },
              },
            ],
          }
        : {
            role: "assistant",
            content:
              afterTool && marker === "mcp"
                ? JSON.stringify(body.messages.at(-1)?.content)
                : "MINIMAX_LOCAL_OK",
          }
      if (["edit", "shell", "shell_full", "mcp"].includes(marker) && !afterTool && !tool)
        throw new Error(
          `Missing ${marker} tool; available: ${tools.map((t) => t.function.name).join(",")}`
        )
      response.writeHead(200, {
        "Content-Type": body.stream ? "text/event-stream" : "application/json",
      })
      if (body.stream) {
        const chunk = {
          id: "local",
          object: "chat.completion.chunk",
          created: 1,
          model: "smoke",
          choices: [
            {
              index: 0,
              delta: tool
                ? { role: "assistant", tool_calls: [{ index: 0, ...message.tool_calls![0] }] }
                : { role: "assistant", content: message.content },
              finish_reason: null,
            },
          ],
        }
        response.write(`data: ${JSON.stringify(chunk)}\n\n`)
        response.write(
          `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\ndata: [DONE]\n\n`
        )
        response.end()
      } else
        response.end(
          JSON.stringify({
            id: "local",
            object: "chat.completion",
            created: 1,
            model: "smoke",
            choices: [{ index: 0, message, finish_reason: tool ? "tool_calls" : "stop" }],
            usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
          })
        )
    } catch (error) {
      response
        .writeHead(500, { "Content-Type": "application/json" })
        .end(JSON.stringify({ error: { message: String(error) } }))
    }
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert(address && typeof address !== "string")
  let stage = "provider-setup"
  const report: Record<string, unknown> = { cloud: false }
  let adapter: MiniMaxAcpAdapter | undefined
  const owned = new Set<string>()
  const diagnostics: string[] = []
  try {
    const version = spawnSync(command, ["--version"], { env, encoding: "utf8", timeout: 15_000 })
    assert.equal(version.status, 0, version.stderr)
    report.version = version.stdout.trim()
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        command,
        [
          "provider",
          "add",
          "--name",
          "cognia-smoke",
          "--base-url",
          `http://127.0.0.1:${address.port}/v1`,
          "--api-format",
          "openai-completions",
          "--model",
          "smoke",
          "--context-limit",
          "131072",
          "--output-limit",
          "4096",
          "--api-key-env",
          "MCODE_PROVIDER_API_KEY",
          "--use",
          "--support-image",
        ],
        { env, timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] }
      )
      let stderr = ""
      child.stderr.on("data", (chunk) => {
        stderr += chunk
      })
      child.on("error", reject)
      child.on("exit", (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`Provider setup failed (${code}): ${stderr.slice(-1000)}`))
      )
    })
    selectCliAgentWorkspace(scratch)
    const config = createAgentFromPreset("minimax-code", {
      id: `minimax-smoke-${randomUUID()}`,
      process: {
        command: "mcode",
        args: ["acp"],
        cwd: scratch,
        env: {
          MINIMAX_DATA_DIR: state,
          MAVIS_DATA_DIR: state,
          MCODE_PROVIDER_API_KEY: "synthetic-local-fixture",
        },
      },
      timeout: 20_000,
      retryConfig: { maxRetries: 0, retryDelay: 0, exponentialBackoff: false },
    })!
    const deps = createAcpClientDeps()
    const processHost = deps.processHost
    deps.processHost = {
      ...processHost,
      send: async (id, message) => {
        const frame = JSON.parse(message)
        if (
          frame.method === "session/prompt" &&
          frame.params.prompt.some((part: { type: string }) => part.type === "image")
        )
          acpImageSent = true
        return processHost.send(id, message)
      },
      onStdoutLine: (handler) =>
        processHost.onStdoutLine((payload) => {
          if (payload.data.includes('"error"')) diagnostics.push(payload.data.slice(-3000))
          handler(payload)
        }),
    }
    deps.logger = {
      debug: (_m, d) => {
        if (d) diagnostics.push(JSON.stringify(d).slice(0, 1000))
      },
      info: () => {},
      warn: () => {},
      error: () => {},
    }
    assert(isolateNativeAcp(config, createAcpClientAdapter(deps)) instanceof MiniMaxAcpAdapter)
    adapter = new MiniMaxAcpAdapter(createAcpClientAdapter(deps), () =>
      createAcpClientAdapter(deps)
    )
    assert(adapter instanceof MiniMaxAcpAdapter)
    stage = "initialize"
    console.log(JSON.stringify({ stage }))
    await adapter.connect(config)
    assert.equal(adapter.capabilities?.imageInput, true)
    const mcpFile = path.join(scratch, "mcp.mjs")
    fs.writeFileSync(
      mcpFile,
      `import readline from 'node:readline';import fs from 'node:fs';readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.id===undefined)return;let result={};if(r.method==='initialize')result={protocolVersion:r.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'smoke',version:'1'}};if(r.method==='tools/list')result={tools:[{name:'probe',description:'Synthetic isolated session marker',inputSchema:{type:'object',properties:{}}}]};if(r.method==='tools/call'){fs.appendFileSync(process.env.RECEIPT,process.env.MARKER+'\\n');result={content:[{type:'text',text:process.env.MARKER}]}};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n')});`
    )
    const mcp = (marker: string) => [
      {
        name: "smoke",
        command: process.execPath,
        args: [mcpFile],
        env: [
          { name: "MARKER", value: marker },
          { name: "RECEIPT", value: path.join(scratch, `${marker}.calls`) },
        ],
      },
    ]
    stage = "create"
    console.log(JSON.stringify({ stage }))
    const a = await adapter.createSession({
      cwd: scratch,
      mcpServers: mcp("first"),
      permissionMode: "default",
    })
    const b = await adapter.createSession({
      cwd: scratch,
      mcpServers: mcp("second"),
      permissionMode: "default",
    })
    owned.add(a.id)
    owned.add(b.id)
    const chooseModel = async (id: string) => {
      const option = adapter!.getConfigOptions(id)?.find((o) => o.category === "model")
      assert(option?.type === "select")
      const models = option.options.flatMap((o) => ("group" in o ? o.options : [o]))
      const model = models.find((o) => o.name.includes("smoke"))
      assert(model, "Synthetic model is not advertised")
      await adapter!.setConfigOption(id, option.id, model.value)
    }
    await Promise.all([chooseModel(a.id), chooseModel(b.id)])
    const turn = async (
      id: string,
      marker: string,
      image = false,
      allow = false,
      signal?: AbortSignal
    ) => {
      let text = ""
      let stop: string | undefined
      let permissions = 0
      const content: ExternalAgentContent[] = [{ type: "text", text: `SMOKE:${marker}` }]
      if (image)
        content.push({
          type: "image",
          source: {
            type: "base64",
            mediaType: "image/png",
            data: "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAb0lEQVR4nO3PAQkAAAyEwO9feoshgnABdLep8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3IPanc8OLDQitxAAAAAElFTkSuQmCC",
          },
        })
      for await (const event of adapter!.prompt(
        id,
        { id: randomUUID(), role: "user", content, timestamp: new Date() },
        { timeout: 35_000, signal }
      )) {
        if (event.type === "message_delta" && event.delta.type === "text") text += event.delta.text
        if (event.type === "done") stop = event.stopReason
        if (event.type === "permission_request") {
          permissions++
          await adapter!.respondToPermission(id, {
            requestId: event.request.requestId ?? event.request.id,
            granted: allow,
            scope: "once",
          })
        }
      }
      return { text, stop, permissions }
    }
    stage = "image"
    console.log(JSON.stringify({ stage }))
    assert.equal((await turn(a.id, "plain", true)).stop, "end_turn")
    assert(receivedImage, "Image did not reach the local provider")
    stage = "permissions"
    console.log(JSON.stringify({ stage }))
    const edited = await turn(a.id, "edit")
    assert.equal(fs.readFileSync(path.join(scratch, "written.txt"), "utf8"), "MINIMAX_LOCAL_OK\n")
    assert.equal(edited.permissions, 0)
    const shell = await turn(a.id, "shell")
    assert.equal(
      fs.existsSync(path.join(scratch, "shell.txt")),
      false,
      "Unapproved shell write executed"
    )
    assert.equal(shell.permissions, 1, "Default must ask for unclassified shell execution")
    for (const unsupported of ["acceptEdits", "dontAsk"] as const)
      await assert.rejects(adapter.setSessionMode(b.id, unsupported), /cannot enforce/)
    for (const mode of ["plan", "bypassPermissions", "default"] as AcpPermissionMode[]) {
      await adapter.setSessionMode(a.id, mode)
      assert.equal(adapter.getSession(a.id)?.permissionMode, mode)
      assert.equal(adapter.getSession(b.id)?.permissionMode, "default")
      if (mode === "plan") {
        const planned = await turn(a.id, "edit PLAN_TARGET")
        assert.equal(planned.stop, "end_turn")
        assert.equal(
          fs.existsSync(path.join(scratch, "plan.txt")),
          false,
          "Plan executed a workspace write"
        )
        assert.equal(
          planned.permissions,
          0,
          "Plan should not surface an approval for a rejected write"
        )
      }
      if (mode === "bypassPermissions") {
        const full = await turn(a.id, "shell_full")
        assert.equal(full.permissions, 0)
        assert.equal(fs.readFileSync(path.join(scratch, "shell.txt"), "utf8"), "MINIMAX_SHELL_OK")
        const sibling = await turn(b.id, "shell_sibling")
        assert.equal(sibling.permissions, 1, "Full access leaked into the sibling process")
        assert.equal(fs.existsSync(path.join(scratch, "sibling.txt")), false)
      }
    }
    report.permissions = {
      nativeDefaultPreapproval: true,
      unclassifiedShellAsked: true,
      unsupportedModesRefused: true,
      planWriteBlocked: true,
      fullAccess: true,
      siblingUnchanged: true,
    }
    stage = "mcp-isolation"
    console.log(JSON.stringify({ stage }))
    await adapter.setSessionMode(b.id, "default")
    await Promise.all([turn(a.id, "mcp", false, true), turn(b.id, "mcp", false, true)])
    assert.equal(fs.readFileSync(path.join(scratch, "first.calls"), "utf8"), "first\n")
    assert.equal(fs.readFileSync(path.join(scratch, "second.calls"), "utf8"), "second\n")
    await adapter.closeSession(b.id)
    await turn(a.id, "mcp", false, true)
    assert.equal(fs.readFileSync(path.join(scratch, "first.calls"), "utf8"), "first\nfirst\n")
    report.mcpIsolation = true
    stage = "restore-fork"
    console.log(JSON.stringify({ stage }))
    assert((await adapter.listSessions({ cwd: scratch })).some((s) => s.sessionId === a.id))
    await adapter.loadSession(a.id, {
      cwd: scratch,
      mcpServers: mcp("first"),
      permissionMode: "default",
    })
    assert.equal((await turn(a.id, "plain")).stop, "end_turn")
    const fork = await adapter.forkSession(a.id, {
      cwd: scratch,
      mcpServers: mcp("fork"),
      permissionMode: "default",
    })
    owned.add(fork.id)
    assert.notEqual(fork.id, a.id)
    await chooseModel(fork.id)
    await turn(fork.id, "mcp", false, true)
    assert.equal(fs.readFileSync(path.join(scratch, "fork.calls"), "utf8"), "fork\n")
    stage = "cancel"
    console.log(JSON.stringify({ stage }))
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 1500)
    try {
      assert.equal((await turn(a.id, "hold", false, false, controller.signal)).stop, "cancelled")
    } finally {
      clearTimeout(timer)
    }
    await adapter.resumeSession(a.id, { cwd: scratch, mcpServers: [], permissionMode: "default" })
    assert.equal((await turn(a.id, "plain")).stop, "end_turn")
    report.lifecycle = { load: true, fork: true, cancel: true, resume: true }
    console.log(JSON.stringify({ result: "PASS", ...report, requests: requests.length }))
  } catch (error) {
    console.error(
      JSON.stringify({
        result: "FAIL",
        stage,
        error: String(error),
        data: (error as { data?: unknown }).data,
        diagnostics: diagnostics.slice(-3),
        requests,
        requestShapes,
        acpImageSent,
      })
    )
    process.exitCode = 1
  } finally {
    for (const id of owned) await adapter?.deleteSession(id).catch(() => undefined)
    await adapter?.disconnect()
    for (const response of held) response.destroy()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    selectCliAgentWorkspace(originalCwd)
    uninstallHost()
    process.env.PATH = originalPath
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}

void main().catch((error) => {
  console.error(String(error))
  process.exitCode = 1
})
