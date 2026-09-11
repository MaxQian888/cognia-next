/**
 * Opt-in live Devin check through Cognia's ACP adapter and real CLI sandbox.
 * The SDK-only acp-live smoke cannot check Cognia's session state or host I/O;
 * external-cognia-parity-smoke instead checks the separate MCP bridge.
 * This spends real SWE-2 tokens and requires an installed, logged-in Devin CLI.
 */
import fs from "node:fs"
import path from "node:path"
import { randomBytes } from "node:crypto"

import { selectCliAgentWorkspace } from "@/cli/src/runtime/external/host-branch"
import { AcpClientAdapter } from "@/lib/ai/agent/external/acp-client"
import { createAgentFromPreset } from "@/lib/ai/agent/external/presets"
import type { ExternalAgentExecutionOptions } from "@/types/agent/external-agent"

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
  adapter: AcpClientAdapter,
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
      // The fixture needs only native read/edit under acceptEdits. Never grant
      // an unexpected shell/network action merely to make a smoke pass.
      await adapter.respondToPermission(sessionId, {
        requestId: event.request.requestId ?? event.request.id,
        granted: false,
        scope: "once",
      })
    }
  }
  return { reply, events, stopReason }
}

async function main(): Promise<void> {
  const originalCwd = fs.realpathSync(process.cwd())
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(originalCwd, ".smoke-devin-acp-")))
  const token = `fixture-${randomBytes(8).toString("hex")}`
  fs.writeFileSync(path.join(scratch, "input.txt"), `${token}\n`, { mode: 0o600 })
  const config = createAgentFromPreset("devin", {
    id: `devin-smoke-${randomBytes(6).toString("hex")}`,
    process: { command: "devin", args: ["acp"], cwd: scratch },
    timeout: 60_000,
  })
  check(config, "Devin preset is missing")
  let adapter = new AcpClientAdapter()
  let sessionId: string | undefined
  let stage = "connect"
  const report: Record<string, unknown> = { model: MODEL }
  try {
    selectCliAgentWorkspace(scratch)
    await adapter.connect(config)
    stage = "create"
    const session = await adapter.createSession({ cwd: scratch, mcpServers: [] })
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

    stage = "native-read-write"
    const first = await bounded(
      prompt(
        adapter,
        sessionId,
        [
          "This is a small fixture check. Use native file read/edit tools only; no shell or MCP.",
          "Read input.txt, then create output.txt with exactly the same content.",
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
      "Native read/write content differs"
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
    adapter = new AcpClientAdapter()
    await adapter.connect(config)
    await adapter.loadSession(sessionId, { cwd: scratch, mcpServers: [] })
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
    if (sessionId && adapter.isConnected()) {
      await bounded(adapter.deleteSession(sessionId), 10_000, "session cleanup").catch(
        () => undefined
      )
    }
    await bounded(adapter.disconnect(), 10_000, "disconnect").catch(() => undefined)
    selectCliAgentWorkspace(originalCwd)
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}

void main().catch(() => {
  process.stderr.write('{"result":"FAIL","stage":"fixture setup"}\n')
  process.exitCode = 1
})
