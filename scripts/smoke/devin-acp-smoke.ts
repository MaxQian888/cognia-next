/**
 * Opt-in live Devin check through Cognia's ACP adapter and real CLI sandbox.
 * The SDK-only acp-live smoke cannot check Cognia's session state or host I/O;
 * external-cognia-parity-smoke instead checks the separate MCP bridge.
 * This spends real SWE-2 tokens and requires an installed, logged-in Devin CLI.
 */
import fs from "node:fs"
import path from "node:path"
import { randomBytes } from "node:crypto"
import os from "node:os"
import { spawnSync } from "node:child_process"

import { selectCliAgentWorkspace } from "@/cli/src/runtime/external/host-branch"
import { DevinAcpAdapter } from "@/lib/ai/agent/external/devin-acp-adapter"
import { createAgentFromPreset } from "@/lib/ai/agent/external/presets"
import type {
  AcpMcpServerConfig,
  ExternalAgentExecutionOptions,
} from "@/types/agent/external-agent"

const MODEL = "swe-2-medium"
const TURN_TIMEOUT_MS = 120_000
const CANCEL_TIMEOUT_MS = 30_000

class SmokeFailure extends Error {}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new SmokeFailure(message)
}

async function bounded<T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new SmokeFailure(`${label} deadline exceeded`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function prompt(
  adapter: DevinAcpAdapter,
  sessionId: string,
  text: string,
  options: ExternalAgentExecutionOptions = {}
) {
  const events: Record<string, number> = {}
  let reply = ""
  let stopReason: string | undefined
  for await (const event of adapter.prompt(
    sessionId,
    {
      id: `devin-smoke-${randomBytes(6).toString("hex")}`,
      role: "user",
      content: [{ type: "text", text }],
      timestamp: new Date(),
    },
    { timeout: TURN_TIMEOUT_MS, ...options }
  )) {
    events[event.type] = (events[event.type] ?? 0) + 1
    if (event.type === "message_delta" && event.delta.type === "text") reply += event.delta.text
    if (event.type === "done") stopReason = event.stopReason
    if (event.type === "permission_request") {
      // Only the purpose-built read-only MCP probe needs explicit approval.
      // Native file operations use acceptEdits; unexpected actions stay denied.
      await adapter.respondToPermission(sessionId, {
        requestId: event.request.requestId ?? event.request.id,
        granted: event.request.toolInfo.name === "mcp__cognia-isolation__verify_session",
        scope: "once",
      })
    }
  }
  return { reply, events, stopReason }
}

function isolationServer(scratch: string, value: string): AcpMcpServerConfig {
  const script = path.join(scratch, "mcp-fixture.mjs")
  if (!fs.existsSync(script)) {
    fs.writeFileSync(
      script,
      `import readline from "node:readline";
import fs from "node:fs";
const lines = readline.createInterface({ input: process.stdin });
for await (const line of lines) {
  const request = JSON.parse(line);
  if (!("id" in request)) continue;
  let result = {};
  if (request.method === "initialize") result = {
    protocolVersion: request.params.protocolVersion,
    capabilities: { tools: {} },
    serverInfo: { name: "cognia-isolation", version: "1" }
  };
  if (request.method === "tools/list") result = { tools: [{
    name: "verify_session", description: "Return this session's isolated test value",
    inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true }
  }] };
  if (request.method === "tools/call") {
    if (request.params.name !== "verify_session") throw new Error("Unexpected fixture tool");
    fs.appendFileSync(process.env.COGNIA_DEVIN_SMOKE_MARKER, "called\\n");
    result = { content: [{ type: "text", text: process.env.COGNIA_DEVIN_SMOKE_VALUE }] };
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
}
`,
      { mode: 0o600 }
    )
  }
  return {
    name: "cognia-isolation",
    command: process.execPath,
    args: [script],
    env: [
      { name: "COGNIA_DEVIN_SMOKE_VALUE", value },
      { name: "COGNIA_DEVIN_SMOKE_MARKER", value: path.join(scratch, `${value}.calls`) },
    ],
  }
}

const ISOLATION_PROMPT =
  "Call mcp__cognia-isolation__verify_session once with {} and reply only with its returned text. Do not use native tools."

async function main(): Promise<void> {
  const originalCwd = fs.realpathSync(process.cwd())
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(originalCwd, ".smoke-devin-acp-")))
  const botIsolation = process.env.COGNIA_DEVIN_BOT_ISOLATION_SMOKE === "1"
  const runtimeState = botIsolation
    ? fs.realpathSync(fs.mkdtempSync(path.join(originalCwd, ".smoke-devin-bot-state-")))
    : undefined
  const token = `fixture-${randomBytes(8).toString("hex")}`
  fs.writeFileSync(path.join(scratch, "input.txt"), `${token}\n`, { mode: 0o600 })
  fs.writeFileSync(path.join(scratch, "package.json"), '{"type":"module"}\n')
  const config = createAgentFromPreset("devin", {
    id: `devin-smoke-${randomBytes(6).toString("hex")}`,
    process: {
      command: "devin",
      args: ["acp"],
      cwd: scratch,
      ...(runtimeState
        ? {
            env: {
              COGNIA_BOT_ISOLATION: "1",
              COGNIA_BOT_STATE_DIR: runtimeState,
              DISABLE_AUTO_UPDATE: "1",
            },
          }
        : {}),
    },
    timeout: 60_000,
  })
  check(config, "Devin preset is missing")
  let adapter = new DevinAcpAdapter()
  let sessionId: string | undefined
  let otherSessionId: string | undefined
  const firstValue = `session-a-${randomBytes(8).toString("hex")}`
  const secondValue = `session-b-${randomBytes(8).toString("hex")}`
  const firstServer = isolationServer(scratch, firstValue)
  const secondServer = isolationServer(scratch, secondValue)
  let stage = "connect"
  const report: Record<string, unknown> = {
    model: MODEL,
    ...(botIsolation ? { botIsolation: true, credentialProbe: "denied" } : {}),
  }
  try {
    if (botIsolation) {
      const marker = path.join(
        os.homedir(),
        `.cognia-bot-isolation-probe-${randomBytes(8).toString("hex")}`
      )
      fs.writeFileSync(marker, "synthetic-credential-probe", { mode: 0o600 })
      try {
        const launcher = process.env.COGNIA_EXTERNAL_AGENT_LAUNCHER
        check(launcher, "Bot isolation smoke requires an explicitly built launcher")
        const probe = spawnSync(
          launcher,
          [
            "--bot-isolation",
            "--cwd",
            scratch,
            "--deny-readable",
            os.homedir(),
            "--",
            "/bin/sh",
            "-c",
            'test -z "$GH_TOKEN" && test -z "$GITHUB_TOKEN" && test -z "$SSH_AUTH_SOCK" && ! /bin/cat "$1" >/dev/null 2>&1 && echo ISOLATED',
            "probe",
            marker,
          ],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              GH_TOKEN: "synthetic",
              GITHUB_TOKEN: "synthetic",
              SSH_AUTH_SOCK: "synthetic",
            },
          }
        )
        check(
          probe.status === 0 && probe.stdout.trim() === "ISOLATED",
          "OS confinement or credential environment scrubbing failed"
        )
      } finally {
        fs.rmSync(marker, { force: true })
      }
    }
    selectCliAgentWorkspace(scratch)
    await adapter.connect(config)
    check(await adapter.healthCheck(), "A responsive Devin connection failed its health check")
    stage = "create"
    const session = await adapter.createSession({ cwd: scratch, mcpServers: [firstServer] })
    sessionId = session.id
    const models = adapter.getSessionModels(sessionId)
    check(
      models?.availableModels.some((model) => model.modelId === MODEL),
      "SWE-2 is not advertised"
    )
    stage = "select-model-and-mode"
    await adapter.setSessionModel(sessionId, MODEL)
    await adapter.setSessionMode(sessionId, "acceptEdits")
    check(
      adapter.getSessionModels(sessionId)?.currentModelId === MODEL,
      "Model selection was not applied"
    )
    check(
      adapter.getSession(sessionId)?.permissionMode === "acceptEdits",
      "Permission mode was not canonicalized"
    )
    report.mode = "acceptEdits"

    stage = "concurrent-mcp-isolation"
    const other = await adapter.createSession({ cwd: scratch, mcpServers: [secondServer] })
    otherSessionId = other.id
    await adapter.setSessionModel(other.id, MODEL)
    await adapter.setSessionMode(other.id, "acceptEdits")
    const [firstMcp, secondMcp] = await bounded(
      Promise.all([
        prompt(adapter, sessionId, ISOLATION_PROMPT),
        prompt(adapter, other.id, ISOLATION_PROMPT),
      ]),
      TURN_TIMEOUT_MS + 5_000,
      stage
    )
    check(
      firstMcp.reply.trim() === firstValue,
      "First session received another session's MCP value"
    )
    check(
      secondMcp.reply.trim() === secondValue,
      "Second session received another session's MCP value"
    )
    check(
      fs.readFileSync(path.join(scratch, `${firstValue}.calls`), "utf8") === "called\n",
      "First MCP tool was not invoked exactly once"
    )
    check(
      fs.readFileSync(path.join(scratch, `${secondValue}.calls`), "utf8") === "called\n",
      "Second MCP tool was not invoked exactly once"
    )
    await adapter.deleteSession(other.id)
    otherSessionId = undefined
    const afterClose = await bounded(
      prompt(adapter, sessionId, ISOLATION_PROMPT),
      TURN_TIMEOUT_MS + 5_000,
      stage
    )
    check(
      afterClose.reply.trim() === firstValue,
      "Closing another session disrupted this session's MCP"
    )
    check(
      fs.readFileSync(path.join(scratch, `${firstValue}.calls`), "utf8") === "called\ncalled\n",
      "Sibling-close verification did not invoke the surviving MCP server"
    )
    report.mcpIsolation = { concurrent: true, siblingClose: true }
    check(await adapter.healthCheck(), "Active Devin sessions failed their health check")
    report.health = true

    stage = "native-read-write"
    const first = await bounded(
      prompt(
        adapter,
        sessionId,
        [
          "This is a small fixture check. Use native file read/edit tools only; no shell or MCP.",
          "Read input.txt, then create output.txt with exactly the same content, including its single trailing newline (LF).",
          "Remember that content for our next message. Reply DONE.",
          "Only read or write files within the current working directory. Do nothing else.",
        ].join("\n")
      ),
      TURN_TIMEOUT_MS + 5_000,
      stage
    )
    check(fs.existsSync(path.join(scratch, "output.txt")), "Native file write produced no output")
    check(
      fs.readFileSync(path.join(scratch, "output.txt"), "utf8") === `${token}\n`,
      `Native read/write content differs: ${JSON.stringify(fs.readFileSync(path.join(scratch, "output.txt"), "utf8"))}`
    )
    check((first.events.tool_result ?? 0) > 0, "No native tool results were observed")
    report.nativeReadWrite = { passed: true, events: first.events }

    stage = "list"
    const sessions = await adapter.listSessions({ cwd: scratch })
    check(
      sessions.some((item) => item.sessionId === sessionId),
      "Created session is absent from its workspace listing"
    )
    report.list = true

    stage = "reconnect-load"
    await adapter.disconnect()
    adapter = new DevinAcpAdapter()
    await adapter.connect(config)
    await adapter.loadSession(sessionId, { cwd: scratch, mcpServers: [firstServer] })
    check(
      adapter.getSessionModels(sessionId)?.currentModelId === MODEL,
      "Loaded session lost its model"
    )
    check(
      adapter.getSession(sessionId)?.permissionMode === "acceptEdits",
      "Loaded session lost its mode"
    )
    report.load = { model: MODEL, mode: "acceptEdits" }

    stage = "followup"
    const followup = await bounded(
      prompt(
        adapter,
        sessionId,
        "Without reading any files or calling tools, reply with only the input.txt content you remember from our earlier turn."
      ),
      TURN_TIMEOUT_MS + 5_000,
      stage
    )
    check(followup.reply.trim() === token, "Loaded conversation did not retain fixture context")
    report.followup = { passed: true, events: followup.events }

    stage = "reloaded-mcp"
    const reloadedMcp = await bounded(
      prompt(adapter, sessionId, ISOLATION_PROMPT),
      TURN_TIMEOUT_MS + 5_000,
      stage
    )
    check(reloadedMcp.reply.trim() === firstValue, "Reloaded session lost its MCP configuration")
    check(
      fs.readFileSync(path.join(scratch, `${firstValue}.calls`), "utf8") ===
        "called\ncalled\ncalled\n",
      "Reload verification did not invoke the MCP server"
    )
    report.mcpReload = true

    stage = "cancellation"
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 1_000)
    try {
      const cancelled = await bounded(
        prompt(
          adapter,
          sessionId,
          "Do not call tools or change files. Count slowly from 1 to 1000, one number per line, until interrupted.",
          { signal: controller.signal, timeout: CANCEL_TIMEOUT_MS }
        ),
        CANCEL_TIMEOUT_MS + 5_000,
        stage
      )
      check(controller.signal.aborted, "Cancellation turn completed before the abort")
      check(cancelled.stopReason === "cancelled", "Agent did not acknowledge cancellation")
      check(
        adapter.getSession(sessionId)?.status === "idle",
        "Cancelled session did not return to idle"
      )
      report.cancellation = { stopReason: cancelled.stopReason, events: cancelled.events }
    } finally {
      clearTimeout(timer)
    }
    process.stdout.write(`${JSON.stringify({ result: "PASS", ...report })}\n`)
  } catch (error) {
    // Vendor errors may contain request context. Print only our own fixed
    // assertions and the stage, never raw agent responses or credentials.
    process.stderr.write(
      `${JSON.stringify({
        result: "FAIL",
        stage,
        reason: error instanceof SmokeFailure ? error.message : "Agent or transport request failed",
        ...report,
      })}\n`
    )
    process.exitCode = 1
  } finally {
    if (otherSessionId && adapter.isConnected()) {
      await bounded(adapter.deleteSession(otherSessionId), 10_000, "other session cleanup").catch(
        () => undefined
      )
    }
    if (sessionId && adapter.isConnected()) {
      await bounded(adapter.deleteSession(sessionId), 10_000, "session cleanup").catch(
        () => undefined
      )
    }
    await bounded(adapter.disconnect(), 10_000, "disconnect").catch(() => undefined)
    selectCliAgentWorkspace(originalCwd)
    fs.rmSync(scratch, { recursive: true, force: true })
    if (runtimeState) fs.rmSync(runtimeState, { recursive: true, force: true })
  }
}

void main().catch(() => {
  process.stderr.write('{"result":"FAIL","stage":"fixture setup"}\n')
  process.exitCode = 1
})
