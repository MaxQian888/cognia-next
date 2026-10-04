import type { AddressInfo } from "node:net"
interface FixtureRequest {
  messages: { role: string; content?: unknown }[]
}
interface FixtureFrame {
  type: string
  error?: unknown
  requestId?: string
  name?: string
  toolUseId?: string
  ok?: boolean
  result?: { retained?: boolean; sdkSessionId?: string; active?: boolean }
  errorCode?: string
  turnId?: string
  transcriptInvalidationId?: string
}
import test from "node:test"
import assert from "node:assert/strict"

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
    const requests: FixtureRequest[] = []
    const server = createServer(async (req, res) => {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body: FixtureRequest = JSON.parse(Buffer.concat(chunks).toString())
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
      const emit = (delta: unknown, finish_reason: string | null = null) =>
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
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const child = spawn(
      process.execPath,
      [new URL("../../agent-host.mjs", import.meta.url).pathname],
      {
        stdio: ["pipe", "pipe", "pipe"],
      }
    )
    let buffer = ""
    let stderr = ""
    const frames: FixtureFrame[] = []
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
    const send = (message: Record<string, unknown>) =>
      child.stdin.write(JSON.stringify({ sessionId: "live-controls", ...message }) + "\n")
    const wait = async (predicate: (frame: FixtureFrame) => boolean, start = 0) => {
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
        baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
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
    const turn = async (prompt: string, respond?: (start: number) => Promise<unknown>) => {
      const start = frames.length
      send({ type: "send", prompt, options })
      if (respond) await respond(start)
      const ended = await wait((frame) => frame.type === "session_ended", start)
      assert.equal(ended.error, undefined)
      return frames.slice(start)
    }
    let controlId = 0
    const mode = async (value: string) => {
      const requestId = "mode-" + ++controlId
      send({ type: "control", requestId, method: "setPermissionMode", params: { mode: value } })
      return wait((frame) => frame.type === "control_response" && frame.requestId === requestId)
    }
    const status = async () => {
      const requestId = "status-" + ++controlId
      send({ type: "control", requestId, method: "runtimeStatus" })
      return wait((frame) => frame.type === "control_response" && frame.requestId === requestId)
    }
    const refusedSend = async (overrides: Record<string, unknown>) => {
      const start = frames.length
      const requestCount = requests.length
      send({
        type: "send",
        prompt: "must-not-run",
        options: {
          ...options,
          turnId: "refused-turn",
          transcriptInvalidationId: "replacement-generation",
          ...overrides,
        },
      })
      const ended = await wait((frame) => frame.type === "session_ended", start)
      assert.equal(ended.turnId, "refused-turn")
      assert.equal(ended.transcriptInvalidationId, "replacement-generation")
      assert.equal(requests.length, requestCount, "refusal occurs before provider or tool effects")
      return ended
    }
    try {
      assert.deepEqual((await status()).result, { retained: false })
      assert.equal(
        (await refusedSend({ expectedRuntimeSessionId: "missing" })).errorCode,
        "RUNTIME_SESSION_NOT_RETAINED"
      )
      assert.match(
        String(
          (
            await refusedSend({
              initialConversation: [{ role: "user", content: "private@example.com" }],
            })
          ).error
        ),
        /PII gate/
      )
      await turn("allowed")
      const retained = (await status()).result
      assert.equal(retained?.retained, true)
      assert.equal(retained?.active, false)
      assert.equal(typeof retained?.sdkSessionId, "string")
      assert.equal(
        (await refusedSend({ expectedRuntimeSessionId: "obsolete" })).errorCode,
        "RUNTIME_SESSION_NOT_RETAINED"
      )
      assert.equal(
        (await status()).result?.sdkSessionId,
        retained?.sdkSessionId,
        "a refused send leaves the retained loop intact"
      )
      assert.equal(await fs.readFile(path.join(workspace, "allowed.txt"), "utf8"), "allowed")
      assert.equal((await mode("plan")).ok, true)
      await turn("blocked")
      await assert.rejects(fs.stat(path.join(workspace, "blocked.txt")), { code: "ENOENT" })
      await turn("read")
      assert.match(JSON.stringify(requests.at(-1)!.messages), /allowed/)
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
      let stale!: FixtureFrame
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
        .at(-1)!
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

test("creating hosts installs no process handlers and isolates observers", async () => {
  const { createAgentHost } = await import("./index.ts")
  const beforeExit = process.listenerCount("beforeExit")
  const uncaught = process.listenerCount("uncaughtException")
  const first = createAgentHost()
  const second = createAgentHost()
  first.emitObservers.add(() => {})
  assert.equal(second.emitObservers.size, 0)
  assert.equal(process.listenerCount("beforeExit"), beforeExit)
  assert.equal(process.listenerCount("uncaughtException"), uncaught)
})
