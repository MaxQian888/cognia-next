/** @jest-environment node */
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs/promises"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import os from "node:os"
import path from "node:path"
import * as pty from "node-pty"
import { TerminalScreen } from "../tui/pty/terminal-screen"
import { nodePtyAvailable } from "../tui/pty/node-pty-harness"

const ROOT = path.resolve(__dirname, "../../..")
const BUNDLE = path.join(ROOT, "cli/dist/cognia-agent.mjs")

describe("packaged built-in coding loop", () => {
  jest.setTimeout(180_000)
  beforeAll(() => {
    const result = spawnSync(
      process.execPath,
      [path.join(ROOT, "scripts/build/build-cli.mjs"), "--js-only"],
      { cwd: ROOT, encoding: "utf8", timeout: 120_000 }
    )
    if (result.status !== 0) throw new Error(result.stderr)
  })

  describe.each(["openai", "anthropic"])("%s through the shipped agent", (protocol) => {
    let resume: (() => Promise<void>) | undefined
    let terminalCheck: (() => Promise<void>) | undefined
    let cleanup: (() => Promise<void>) | undefined
    afterAll(async () => {
      await cleanup?.()
    })
    it("completes the coding, scoped process, and search chain", async () => {
      const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "cognia-coding-loop-"))
      await fs.writeFile(path.join(workspace, "move-me.txt"), "MOVE_VERIFIED")
      await fs.writeFile(path.join(workspace, "answer.cjs"), "module.exports = 1\n")
      await fs.writeFile(
        path.join(workspace, "answer.test.cjs"),
        'const assert = require("node:assert/strict"); assert.equal(require("./answer.cjs"), 3); console.log("FIXTURE_TEST_PASSED")\n'
      )
      await fs.writeFile(
        path.join(workspace, "symbols.js"),
        "function fixtureDouble(value) { return value * 2 }\nconsole.log(fixtureDouble(3))\n"
      )
      await fs.mkdir(path.join(workspace, ".cognia"))
      const lspScript = path.join(workspace, "fixture-lsp.cjs")
      await fs.writeFile(
        lspScript,
        `
let buffer = Buffer.alloc(0);
process.stdin.on("data", chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf("\\r\\n\\r\\n");
    if (headerEnd < 0) return;
    const length = Number(/Content-Length: (\\d+)/i.exec(buffer.subarray(0, headerEnd).toString())[1]);
    if (buffer.length < headerEnd + 4 + length) return;
    const request = JSON.parse(buffer.subarray(headerEnd + 4, headerEnd + 4 + length));
    buffer = buffer.subarray(headerEnd + 4 + length);
    if (request.method === "exit") process.exit(0);
    if (request.id === undefined) continue;
    const result = request.method === "initialize" ? { capabilities: { hoverProvider: true, textDocumentSync: 1 } } : request.method === "textDocument/hover" ? { contents: { kind: "markdown", value: "FIXTURE_LSP_HOVER" } } : null;
    const body = JSON.stringify({ jsonrpc: "2.0", id: request.id, result });
    process.stdout.write("Content-Length: " + Buffer.byteLength(body) + "\\r\\n\\r\\n" + body);
  }
});
`
      )
      await fs.writeFile(
        path.join(workspace, ".cognia/lsp.json"),
        JSON.stringify({
          servers: [
            { id: "typescript", command: process.execPath, args: [lspScript], rootMarkers: [] },
          ],
        })
      )
      const commands: Array<{ name: string; input: Record<string, unknown> }> = [
        { name: "read", input: { file_path: "answer.cjs" } },
        {
          name: "sandbox_write",
          input: { path: path.join(workspace, "answer.cjs"), content: "module.exports = 2\n" },
        },
        { name: "bash", input: { command: "node --test answer.test.cjs" } },
        { name: "read", input: { file_path: "answer.cjs" } },
        {
          name: "sandbox_write",
          input: { path: path.join(workspace, "answer.cjs"), content: "module.exports = 3\n" },
        },
        { name: "bash", input: { command: "node --test answer.test.cjs" } },
      ]
      const requests: Array<{
        tools: Array<{ function?: { name: string }; name?: string }>
        messages: Array<{ role: string; content: unknown }>
      }> = []
      const terminalRequests: typeof requests = []
      let terminalCommands: typeof commands = []
      const server = createServer(async (req, res) => {
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        if (
          !req.url?.includes(protocol === "anthropic" ? "/messages" : "/chat/completions") ||
          req.url?.includes("count_tokens")
        ) {
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({ input_tokens: 100 }))
          return
        }
        const payload = JSON.parse(Buffer.concat(chunks).toString() || "{}")
        const auxiliary =
          protocol === "anthropic" &&
          !payload.tools?.length &&
          !payload.messages?.some(
            (message: { content?: Array<{ type?: string }> }) =>
              Array.isArray(message.content) &&
              message.content.some((part) => part.type === "tool_use")
          )
        const terminalOnly = JSON.stringify(payload.messages).includes("TERMINAL_ONLY")
        const activeRequests = terminalOnly ? terminalRequests : requests
        if (!auxiliary) activeRequests.push(payload)
        res.writeHead(200, { "content-type": "text/event-stream" })
        const emit = (delta: unknown, finish_reason: string | null = null) =>
          res.write(
            `data: ${JSON.stringify({ id: "chatcmpl-scripted", object: "chat.completion.chunk", created: 1, model: "scripted", choices: [{ index: 0, delta, finish_reason }] })}\n\n`
          )
        const messageText = JSON.stringify(payload.messages)
        const replyText = terminalOnly
          ? "TERMINAL_COMPLETE"
          : messageText.includes("confirm again in this same session")
            ? "FOLLOWUP_AGAIN_COMPLETE"
            : messageText.includes("FOLLOWUP_REQUEST")
              ? "FOLLOWUP_COMPLETE"
              : "CODING_LOOP_COMPLETE"
        const command = auxiliary
          ? undefined
          : (terminalOnly ? terminalCommands : commands)[activeRequests.length - 1]
        if (command?.input.shellId === "BACKGROUND" || command?.input.sessionId === "TERMINAL") {
          const messages = payload.messages ?? []
          const outputs =
            protocol === "openai"
              ? messages
                  .filter((message: { role: string }) => message.role === "tool")
                  .map((message: { content: string }) => message.content)
              : messages.flatMap((message: { content: unknown }) =>
                  Array.isArray(message.content)
                    ? message.content
                        .filter((part: { type: string }) => part.type === "tool_result")
                        .map((part: { content: unknown }) =>
                          typeof part.content === "string"
                            ? part.content
                            : Array.isArray(part.content)
                              ? part.content.map((item: { text: string }) => item.text).join("\n")
                              : ""
                        )
                    : []
                )
          if (command.input.shellId === "BACKGROUND") {
            try {
              command.input.shellId = JSON.parse(outputs.at(-1)).jobId ?? "missing-background-id"
            } catch {
              command.input.shellId = "missing-background-id"
            }
          } else {
            command.input.sessionId =
              outputs
                .slice()
                .reverse()
                .flatMap((value: string) => {
                  try {
                    return [JSON.parse(value)]
                  } catch {
                    return []
                  }
                })
                .find((value: { sessionId?: string }) => value.sessionId)?.sessionId ??
              "missing-terminal-id"
          }
        }

        if (command?.name === "terminal_repl_read")
          await new Promise((resolve) => setTimeout(resolve, 500))
        if (protocol === "anthropic") {
          const event = (type: string, data: Record<string, unknown>) =>
            res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
          event("message_start", {
            message: {
              id: `msg-${terminalOnly ? "terminal-" : ""}${activeRequests.length}`,
              type: "message",
              role: "assistant",
              model: payload.model,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 100, output_tokens: 0 },
            },
          })
          if (command) {
            const names =
              activeRequests
                .find((request) => request.tools?.length)
                ?.tools.map((tool) => tool.name ?? "") ?? []
            const target = command.name === "bash" ? "sandbox_bash" : command.name
            const name =
              names.find((name: string) => name === target || name.endsWith(`__${target}`)) ??
              names.find((name: string) => name.toLowerCase() === target)
            event("content_block_start", {
              index: 0,
              content_block: {
                type: "tool_use",
                id: `call-${terminalOnly ? "terminal-" : ""}${activeRequests.length}`,
                name: name ?? command.name,
                input: {},
              },
            })
            const args = JSON.stringify(
              command.name === "bash" ? { ...command.input, cwd: workspace } : command.input
            )
            const mid = Math.floor(args.length / 2)
            event("content_block_delta", {
              index: 0,
              delta: { type: "input_json_delta", partial_json: args.slice(0, mid) },
            })
            event("content_block_delta", {
              index: 0,
              delta: { type: "input_json_delta", partial_json: args.slice(mid) },
            })
          } else {
            event("content_block_start", { index: 0, content_block: { type: "text", text: "" } })
            event("content_block_delta", {
              index: 0,
              delta: { type: "text_delta", text: replyText },
            })
          }
          event("content_block_stop", { index: 0 })
          event("message_delta", {
            delta: { stop_reason: command ? "tool_use" : "end_turn", stop_sequence: null },
            usage: { output_tokens: 20 },
          })
          event("message_stop", {})
          res.end()
          return
        }
        if (command) {
          const args = JSON.stringify(command.input)
          const middle = Math.floor(args.length / 2)
          emit({
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: `call-${terminalOnly ? "terminal-" : ""}${activeRequests.length}`,
                type: "function",
                function: { name: command.name, arguments: args.slice(0, middle) },
              },
            ],
          })
          emit({ tool_calls: [{ index: 0, function: { arguments: args.slice(middle) } }] })
          emit({}, "tool_calls")
        } else {
          emit({ role: "assistant", content: replyText })
          emit({}, "stop")
        }
        res.end("data: [DONE]\n\n")
      })
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
      const outside = `${workspace}-outside`
      await fs.writeFile(
        path.join(workspace, "boundary.test.cjs"),
        `
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
assert.throws(() => fs.writeFileSync(${JSON.stringify(outside)}, "escaped"), /EPERM|EACCES|Operation not permitted/);
const socket = net.connect({ host: "127.0.0.1", port: ${(server.address() as AddressInfo).port} });
socket.on("connect", () => { socket.destroy(); process.exitCode = 1; console.error("NETWORK_ESCAPED"); });
socket.on("error", () => { console.log("SANDBOX_BOUNDARIES_VERIFIED"); });
socket.setTimeout(3000, () => { socket.destroy(); process.exitCode = 1; });
`
      )
      commands.push(
        { name: "bash", input: { command: "node --test boundary.test.cjs" } },
        { name: "codegraph_search", input: { query: "fixtureDouble" } },
        {
          name: "ast_grep_search",
          input: {
            pattern: "console.log($VALUE)",
            lang: "javascript",
            paths: [path.join(workspace, "symbols.js")],
          },
        },
        {
          name: "lsp_hover",
          input: { file: path.join(workspace, "symbols.js"), line: 1, character: 15 },
        }
      )
      commands.push(
        {
          name: "start_process",
          input: {
            program: "node",
            args: ["--test", "answer.test.cjs"],
            cwd: workspace,
            detached: true,
          },
        },
        { name: "bash_output", input: { shellId: "BACKGROUND", wait_ms: 5000 } }
      )
      commands.push(
        {
          name: "directory_create",
          input: { path: path.join(workspace, "moved"), recursive: true },
        },
        {
          name: "file_move",
          input: {
            source: path.join(workspace, "move-me.txt"),
            destination: path.join(workspace, "moved/move-me.txt"),
          },
        },
        {
          name: "terminal_repl_spawn",
          input: {
            agentId: "coding-fixture",
            shell: "node",
            args: [
              "-e",
              "process.stdin.once('data', () => { console.log('TERMINAL_EXECUTED'); setTimeout(() => {}, 10000) })",
            ],
            cwd: workspace,
          },
        },
        {
          name: "terminal_repl_write",
          input: { agentId: "coding-fixture", sessionId: "TERMINAL", data: "go\n" },
        },
        {
          name: "terminal_repl_read",
          input: { agentId: "coding-fixture", sessionId: "TERMINAL", drain: false },
        },
        { name: "terminal_repl_kill", input: { agentId: "coding-fixture", sessionId: "TERMINAL" } }
      )
      terminalCommands = commands.splice(14)
      const home = path.join(workspace, "home")
      await fs.mkdir(home)
      await fs.writeFile(
        path.join(home, "config.json"),
        JSON.stringify({
          provider: protocol === "anthropic" ? "anthropic" : "scripted",
          model: protocol === "anthropic" ? "claude-sonnet-4-5" : "scripted",
          providers: {
            [protocol === "anthropic" ? "anthropic" : "scripted"]: {
              protocol,
              baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}${protocol === "anthropic" ? "" : "/v1"}`,
              apiKey: "test-local-only",
            },
          },
        })
      )
      const runCli = (args: string[]) =>
        new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
          const child = spawn(process.execPath, [BUNDLE, ...args], {
            cwd: workspace,
            env: {
              NODE_ENV: "test",
              PATH: process.env.PATH,
              HOME: workspace,
              COGNIA_HOME: home,
              NO_COLOR: "1",
              ...(process.env.COGNIA_SANDBOX_EXEC
                ? { COGNIA_SANDBOX_EXEC: process.env.COGNIA_SANDBOX_EXEC }
                : {}),
            },
            stdio: ["ignore", "pipe", "pipe"],
          })
          let stdout = "",
            stderr = ""
          child.stdout.on("data", (chunk) => {
            stdout += chunk
          })
          child.stderr.on("data", (chunk) => {
            stderr += chunk
          })
          const timer = setTimeout(() => {
            child.kill("SIGKILL")
            reject(
              new Error(
                `Timed out after ${requests.length} requests (next ${commands[requests.length - 1]?.name}): ${stdout.slice(-3000)}\n${stderr.slice(-3000)}`
              )
            )
          }, 90_000)
          child.on("error", reject)
          child.on("close", (code) => {
            clearTimeout(timer)
            resolve({ code, stdout, stderr })
          })
        })
      terminalCheck = async () => {
        terminalRequests.length = 0
        for (const command of terminalCommands) {
          if ("sessionId" in command.input) command.input.sessionId = "TERMINAL"
        }
        const output = await runCli([
          "run",
          "TERMINAL_ONLY: run the explicitly authorized terminal tools.",
          "--allow",
          terminalCommands
            .map((command) => command.name)
            .flatMap((name) => [name, `mcp__cognia-tools__${name}`])
            .join(","),
        ])
        if (output.code !== 0) throw new Error(JSON.stringify(output))
        expect(output.stdout).toContain("TERMINAL_COMPLETE")
        expect(terminalRequests).toHaveLength(5)
        const results = terminalRequests
          .flatMap((request) => request.messages)
          .flatMap((message) =>
            message.role === "tool"
              ? [message.content]
              : Array.isArray(message.content)
                ? message.content
                    .filter((block: { type?: string }) => block.type === "tool_result")
                    .map((block: { content: unknown }) => block.content)
                : []
          )
        expect(JSON.stringify(results[0])).toContain("sessionId")
        expect(JSON.stringify(results)).toContain("TERMINAL_EXECUTED")
      }
      try {
        const output = await runCli([
          "run",
          "Inspect and fix the fixture, run its test, then summarize.",
        ])
        if (output.code !== 0) throw new Error(JSON.stringify(output))
        expect(output.stdout).toContain("CODING_LOOP_COMPLETE")
        expect(requests).toHaveLength(commands.length + 1)
        const codingRequest = requests.at(-1)!
        resume = async () => {
          if (nodePtyAvailable()) {
            const geometry = { columns: 110, rows: 36 }
            const screen = new TerminalScreen(geometry)
            let closed = false
            let raw = ""
            const terminal = pty.spawn(process.execPath, [BUNDLE, "chat", "--continue"], {
              name: "xterm-256color",
              cols: geometry.columns,
              rows: geometry.rows,
              cwd: workspace,
              env: {
                NODE_ENV: "test",
                PATH: process.env.PATH,
                HOME: workspace,
                COGNIA_HOME: home,
                TERM: "xterm-256color",
                NO_COLOR: "1",
                ...(process.env.COGNIA_SANDBOX_EXEC
                  ? { COGNIA_SANDBOX_EXEC: process.env.COGNIA_SANDBOX_EXEC }
                  : {}),
              },
            })
            terminal.onData((data) => {
              raw += data
              screen.write(data)
            })
            terminal.onExit(() => {
              closed = true
            })
            const waitFor = async (predicate: () => boolean, label: string) => {
              const deadline = Date.now() + 25_000
              while (!predicate()) {
                if (closed || Date.now() > deadline)
                  throw new Error(`${protocol} PTY ${label}: ${screen.text()}\n${raw.slice(-1500)}`)
                await new Promise((resolve) => setTimeout(resolve, 50))
              }
            }
            const send = async (text: string) => {
              let typed = ""
              for (const char of text) {
                terminal.write(char)
                typed += char
                await waitFor(() => screen.flatText().includes(typed), `typed ${typed}`)
              }
              terminal.write("\r")
            }

            try {
              await waitFor(
                () =>
                  screen.flatText().includes("Do you trust") ||
                  screen.flatText().includes("Ask, run"),
                "workspace gate"
              )
              if (screen.flatText().includes("Do you trust")) {
                await new Promise((resolve) => setTimeout(resolve, 200))
                terminal.write("\r")
              }
              await waitFor(() => screen.flatText().includes("Ask, run"), "composer")
              const beforeResume = requests.length
              await send("FOLLOWUP_REQUEST: confirm the previous coding result.")
              await waitFor(
                () =>
                  requests.length > beforeResume && screen.flatText().includes("FOLLOWUP_COMPLETE"),
                "resumed reply"
              )
              expect(JSON.stringify(requests.at(-1)!.messages)).toContain(
                "Inspect and fix the fixture"
              )
              expect(JSON.stringify(requests.at(-1)!.messages)).toContain("FIXTURE_TEST_PASSED")
              const beforeFollowup = requests.length
              await send("FOLLOWUP_REQUEST: confirm again in this same session.")
              await waitFor(
                () =>
                  requests.length > beforeFollowup &&
                  screen.flatText().includes("FOLLOWUP_AGAIN_COMPLETE"),
                "live follow-up reply"
              )
              expect(JSON.stringify(requests.at(-1)!.messages)).toContain(
                "confirm the previous coding result"
              )
              await send("TERMINAL_ONLY: verify the terminal with interactive approval.")
              await waitFor(() => screen.flatText().includes("Allow once"), "terminal approval")
              // Leave the overlay mounted through live render updates before approving.
              await new Promise((resolve) => setTimeout(resolve, 350))
              let approvedRequest = -1
              let approvalCount = 0
              await waitFor(() => {
                if (
                  screen.flatText().includes("Enter confirm") &&
                  approvedRequest !== terminalRequests.length
                ) {
                  approvedRequest = terminalRequests.length
                  approvalCount++
                  terminal.write("\r")
                }
                return screen.flatText().includes("TERMINAL_COMPLETE")
              }, "approved terminal result")
              expect(approvalCount).toBeGreaterThanOrEqual(2)
              process.stdout.write(`${protocol} actual TUI approvals: ${approvalCount}\n`)
              const approvedOutputs = terminalRequests
                .flatMap((request) => request.messages)
                .flatMap((message) =>
                  message.role === "tool"
                    ? [message.content]
                    : Array.isArray(message.content)
                      ? message.content
                          .filter((block: { type?: string }) => block.type === "tool_result")
                          .map((block: { content: unknown }) => block.content)
                      : []
                )
              expect(JSON.stringify(approvedOutputs)).toContain("TERMINAL_EXECUTED")
            } finally {
              terminal.write("\u0003")
              await new Promise((resolve) => setTimeout(resolve, 150))
              terminal.write("\u0003")
              const deadline = Date.now() + 3000
              while (!closed && Date.now() < deadline)
                await new Promise((resolve) => setTimeout(resolve, 50))
              if (!closed) terminal.kill()
            }
          }
        }
        const tools = requests[0].tools.map((tool) =>
          (tool.function?.name ?? tool.name ?? "").split("__").at(-1)!.toLowerCase()
        )
        const required = [
          "read",
          "sandbox_write",
          protocol === "anthropic" ? "sandbox_bash" : "bash",
          "codegraph_search",
          "ast_grep_search",
          "lsp_hover",
          "terminal_repl_spawn",
        ]
        const missing = required.filter((name) => !tools.includes(name))
        if (missing.length)
          throw new Error(
            `Missing advertised coding tools: ${missing.join(", ")}\n${output.stderr}`
          )
        expect(tools).toEqual(
          expect.arrayContaining([
            "read",
            "sandbox_write",
            protocol === "anthropic" ? "sandbox_bash" : "bash",
            "codegraph_search",
            "ast_grep_search",
            "lsp_hover",
            "terminal_repl_spawn",
          ])
        )
        const toolResults =
          protocol === "openai"
            ? codingRequest.messages.filter((message) => message.role === "tool")
            : codingRequest.messages.flatMap((message) =>
                Array.isArray(message.content)
                  ? message.content
                      .filter((block: { type?: string }) => block.type === "tool_result")
                      .map((block: { content: unknown }) => ({
                        content:
                          typeof block.content === "string"
                            ? block.content
                            : Array.isArray(block.content)
                              ? block.content
                                  .map((item: { text?: string }) => item.text ?? "")
                                  .join("\n")
                              : block.content,
                      }))
                  : []
              )
        expect(toolResults).toHaveLength(commands.length)
        expect(JSON.parse(String(toolResults[1].content))).toMatchObject({ exit_code: 0 })
        expect(JSON.parse(String(toolResults[4].content))).toMatchObject({ exit_code: 0 })
        expect(JSON.stringify(toolResults[0])).toContain("module.exports = 1")
        expect(JSON.stringify(toolResults[2])).toContain("fail 1")
        expect(JSON.stringify(toolResults[3])).toContain("module.exports = 2")
        expect(JSON.stringify(toolResults[5])).toContain("FIXTURE_TEST_PASSED")
        expect(JSON.stringify(toolResults[6])).toContain("SANDBOX_BOUNDARIES_VERIFIED")
        expect(JSON.stringify(toolResults[7])).toContain("fixtureDouble")
        expect(JSON.stringify(toolResults[9])).toContain("FIXTURE_LSP_HOVER")
        expect(JSON.stringify(toolResults[8])).toContain("fixtureDouble")
        expect(JSON.stringify(toolResults[10])).toContain("jobId")
        expect(JSON.stringify(toolResults[11])).toContain("FIXTURE_TEST_PASSED")
        expect(await fs.readFile(path.join(workspace, "moved/move-me.txt"), "utf8")).toBe(
          "MOVE_VERIFIED"
        )
        await expect(fs.stat(path.join(workspace, "move-me.txt"))).rejects.toMatchObject({
          code: "ENOENT",
        })
        await expect(fs.stat(outside)).rejects.toMatchObject({ code: "ENOENT" })
        expect(await fs.readFile(path.join(workspace, "answer.cjs"), "utf8")).toBe(
          "module.exports = 3\n"
        )
      } finally {
        cleanup = async () => {
          server.closeAllConnections()
          await new Promise<void>((resolve) => server.close(() => resolve()))
          await fs.rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
          await fs.rm(outside, { force: true })
        }
      }
    })
    it("restores provider history after restart and continues the live session", async () => {
      expect(resume).toBeDefined()
      await resume!()
    })
    it("executes explicitly scoped persistent terminal input and output", async () => {
      expect(terminalCheck).toBeDefined()
      await terminalCheck!()
    })
  })
})
