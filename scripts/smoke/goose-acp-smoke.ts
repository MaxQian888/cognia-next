/** Opt-in live Goose check through Cognia's ACP adapter and CLI sandbox.
 * Uses provider credentials from the environment and only temporary state.
 * Other live smokes are vendor-specific and cannot verify Goose mode mapping.
 */
import fs from "node:fs"
import path from "node:path"
import { randomBytes } from "node:crypto"
import { spawnSync } from "node:child_process"
import { selectCliAgentWorkspace } from "@/cli/src/runtime/external/host-branch"
import { createAcpClientAdapter } from "@/lib/ai/agent/external/integrations/acp"
import { createAgentFromPreset } from "@/lib/ai/agent/external/config/presets"
import { findRuntimeByPresetId } from "@/lib/ai/agent/external/config/install-catalog"
import { assessRuntimeVersion } from "@/lib/ai/agent/external/config/runtime-version"
import type {
  AcpMcpServerConfig,
  ExternalAgentExecutionOptions,
} from "@/types/agent/external-agent"

class SmokeFailure extends Error {}
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new SmokeFailure(message)
}
async function bounded<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new SmokeFailure(`${label} deadline exceeded`)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function isolationServer(scratch: string, value: string): AcpMcpServerConfig {
  const script = path.join(scratch, "mcp-fixture.mjs")
  if (!fs.existsSync(script))
    fs.writeFileSync(
      script,
      `
import readline from "node:readline";
import fs from "node:fs";
for await (const line of readline.createInterface({ input: process.stdin })) {
  const req = JSON.parse(line);
  if (!("id" in req)) continue;
  let result = {};
  if (req.method === "initialize") result = { protocolVersion: req.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "cognia-smoke", version: "1" } };
  if (req.method === "tools/list") result = { tools: [{ name: "verify_session", description: "Return this session's fixture value", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } }] };
  if (req.method === "tools/call") {
    if (req.params.name !== "verify_session") throw new Error("Unexpected fixture tool");
    fs.appendFileSync(process.env.COGNIA_GOOSE_MARKER, "called\\n");
    result = { content: [{ type: "text", text: process.env.COGNIA_GOOSE_VALUE }] };
  }
  if (!["initialize", "tools/list", "tools/call", "ping"].includes(req.method)) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "Method not found" } }) + "\\n");
    continue;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }) + "\\n");
}
`,
      { mode: 0o600 }
    )
  return {
    name: "cognia-smoke",
    command: process.execPath,
    args: [script],
    env: [
      { name: "COGNIA_GOOSE_VALUE", value },
      { name: "COGNIA_GOOSE_MARKER", value: path.join(scratch, `${value}.calls`) },
    ],
  }
}

async function main() {
  check(process.env.GOOSE_PROVIDER && process.env.GOOSE_MODEL, "Set GOOSE_PROVIDER and GOOSE_MODEL")
  const original = fs.realpathSync(process.cwd())
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(original, ".smoke-goose-acp-")))
  const token = `fixture-${randomBytes(8).toString("hex")}`
  fs.writeFileSync(path.join(scratch, "input.txt"), `${token}\n`, { mode: 0o600 })
  const config = createAgentFromPreset("goose", {
    id: `goose-smoke-${randomBytes(6).toString("hex")}`,
    process: {
      command: "goose",
      args: ["acp", "--with-builtin", "developer"],
      cwd: scratch,
      env: { GOOSE_PATH_ROOT: path.join(scratch, "goose-state") },
    },
    timeout: 60_000,
  })
  check(config, "Goose preset is missing")
  let adapter = createAcpClientAdapter()
  let sessionId: string | undefined
  const otherSessions: string[] = []
  let stage = "connect"
  const report: Record<string, unknown> = { model: process.env.GOOSE_MODEL }
  const prompt = async (
    text: string,
    options: ExternalAgentExecutionOptions = {},
    targetSessionId = sessionId
  ) => {
    check(targetSessionId, "Session not created")
    let reply = ""
    let stopReason: string | undefined
    const events: Record<string, number> = {}
    const permissionTools: string[] = []
    for await (const event of adapter.prompt(
      targetSessionId,
      {
        id: `goose-${randomBytes(6).toString("hex")}`,
        role: "user",
        content: [{ type: "text", text }],
        timestamp: new Date(),
      },
      { timeout: 120_000, ...options }
    )) {
      events[event.type] = (events[event.type] ?? 0) + 1
      if (event.type === "message_delta" && event.delta.type === "text") reply += event.delta.text
      if (event.type === "done") stopReason = event.stopReason
      if (event.type === "permission_request") {
        permissionTools.push(event.request.toolInfo.name)
        // This fixture grants only Goose's native editor within the temporary workspace.
        await adapter.respondToPermission(targetSessionId, {
          requestId: event.request.requestId ?? event.request.id,
          granted: (() => {
            if (
              [
                "cognia-smoke__verify_session",
                "extensionmanager__search_available_extensions",
              ].includes(event.request.toolInfo.name)
            )
              return true
            const input = event.request.rawInput
            if (event.request.toolInfo.name === "extensionmanager__manage_extensions") {
              return input?.action === "enable" && input?.extension_name === "cognia-smoke"
            }
            const file = typeof input?.path === "string" ? input.path : undefined
            if (!file || !/^(read|write|edit)\b/i.test(event.request.toolInfo.name)) return false
            const relative = path.relative(scratch, path.resolve(scratch, file))
            return relative === "input.txt" || relative === "output.txt"
          })(),
          scope: "once",
        })
      }
    }
    return { reply, events, stopReason, permissionTools }
  }
  try {
    const runtime = findRuntimeByPresetId("goose")!
    const version = spawnSync("goose", runtime.versionProbe!.args, {
      encoding: "utf8",
      timeout: runtime.versionProbe!.timeoutMs,
    })
    check(version.status === 0, "Goose version probe failed")
    const assessment = assessRuntimeVersion(runtime, {
      parser: runtime.versionProbe!.parser,
      output: version.stdout,
      checkedAt: new Date().toISOString(),
    })
    check(
      assessment.verdict === "certified" || assessment.verdict === "supported-uncertified",
      "Goose version is unsupported"
    )
    report.runtime = { version: assessment.detectedVersion, verdict: assessment.verdict }
    selectCliAgentWorkspace(scratch)
    await adapter.connect(config)
    check(await adapter.healthCheck(), "Connected Goose failed its health check")
    report.connection = true
    stage = "create-and-modes"
    const session = await adapter.createSession({ cwd: scratch })
    sessionId = session.id
    check(session.permissionMode === "default", "Goose did not start in approval mode")
    for (const mode of ["plan", "bypassPermissions", "acceptEdits", "default"] as const) {
      await adapter.setSessionMode(sessionId, mode)
      check(
        adapter.getSession(sessionId)?.permissionMode === mode,
        "Mode mapping did not round trip"
      )
    }
    report.modes = true
    stage = "native-read-write"
    const first = await bounded(
      prompt(
        "Use developer text_editor to read input.txt and create output.txt with exactly the same contents including its trailing newline. Remember the contents for our next turn. Use no shell, network, or other tools. Reply DONE."
      ),
      125_000,
      stage
    )
    report.nativeReadWrite = first.events
    check(first.stopReason === "end_turn", "Native file turn did not finish")
    check(fs.existsSync(path.join(scratch, "output.txt")), "No native output file was created")
    check(
      fs.readFileSync(path.join(scratch, "output.txt"), "utf8") === `${token}\n`,
      "Native file contents differ"
    )
    check((first.events.permission_request ?? 0) > 0, "No approval request was received")
    check((first.events.tool_result ?? 0) > 0, "No native tool result was received")
    report.nativeReadWrite = first.events
    stage = "list"
    const listing = await adapter.listSessions({ cwd: scratch })
    check(
      listing.some((entry) => entry.sessionId === sessionId),
      "Session listing omitted the created session"
    )
    report.list = true
    stage = "reconnect-load"
    await adapter.disconnect()
    adapter = createAcpClientAdapter()
    await adapter.connect(config)
    await adapter.loadSession(sessionId, { cwd: scratch })
    report.load = true
    stage = "followup"
    const next = await bounded(
      prompt(
        "Without tools, reply only with the input.txt contents you remember from our previous turn."
      ),
      125_000,
      stage
    )
    check(next.reply.trim() === token, "Loaded conversation lost its earlier context")
    report.followup = next.events
    stage = "accept-edits"
    await adapter.setSessionMode(sessionId, "acceptEdits")
    const accepted = await bounded(
      prompt(
        "Read input.txt with the read tool and reply only with its contents. Do not use other tools."
      ),
      125_000,
      stage
    )
    check(
      accepted.reply.trim() === token && (accepted.events.tool_result ?? 0) > 0,
      "acceptEdits read did not execute"
    )
    check(
      !accepted.events.permission_request,
      "acceptEdits still requested manual approval for a file read"
    )
    report.acceptEdits = accepted.events
    await adapter.setSessionMode(sessionId, "default")

    stage = "mcp-isolation"
    const values = ["a", "b"].map((prefix) => `${prefix}-${randomBytes(8).toString("hex")}`)
    for (const value of values) {
      const other = await adapter.createSession({
        cwd: scratch,
        mcpServers: [isolationServer(scratch, value)],
      })
      otherSessions.push(other.id)
    }
    const question =
      "If necessary, discover cognia-smoke with extensionmanager__search_available_extensions. Then call cognia-smoke's verify_session exactly once and reply only with the returned value. Use no file, shell, or other tools."
    const results = await bounded(
      Promise.all(otherSessions.map((id) => prompt(question, {}, id))),
      125_000,
      stage
    )
    report.mcpEvents = results.map((result, index) => ({
      events: result.events,
      permissionTools: result.permissionTools,
      invoked: fs.existsSync(path.join(scratch, `${values[index]}.calls`)),
      matches: values.indexOf(result.reply.trim()),
    }))
    for (let i = 0; i < values.length; i++) {
      check(
        results[i].reply.trim() === values[i],
        "Concurrent session received the wrong MCP value"
      )
      check(
        fs.readFileSync(path.join(scratch, `${values[i]}.calls`), "utf8") === "called\n",
        "MCP tool did not run exactly once"
      )
    }
    await adapter.deleteSession(otherSessions.pop()!)
    const survivor = await bounded(prompt(question, {}, otherSessions[0]), 125_000, stage)
    check(
      survivor.reply.trim() === values[0],
      "Closing a sibling disrupted the remaining MCP server"
    )
    check(
      fs.readFileSync(path.join(scratch, `${values[0]}.calls`), "utf8") === "called\ncalled\n",
      "Remaining MCP tool did not execute again"
    )
    await adapter.deleteSession(otherSessions.pop()!)
    report.mcpIsolation = { concurrent: true, siblingClose: true }

    stage = "cancel"
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 1_000)
    try {
      const cancelled = await bounded(
        prompt("Without tools, count slowly from 1 to 10000 until interrupted.", {
          signal: controller.signal,
          timeout: 30_000,
        }),
        35_000,
        stage
      )
      check(
        controller.signal.aborted && cancelled.stopReason === "cancelled",
        "Goose did not acknowledge cancellation"
      )
      check(adapter.getSession(sessionId)?.status === "idle", "Cancelled session is not idle")
      report.cancel = cancelled.events
    } finally {
      clearTimeout(timer)
    }
    stage = "delete"
    await adapter.deleteSession(sessionId)
    check(!adapter.getSession(sessionId), "Deleted session remains in client state")
    sessionId = undefined
    report.delete = true
    process.stdout.write(`${JSON.stringify({ result: "PASS", ...report })}\n`)
  } catch (error) {
    // Never print vendor request payloads or provider credentials.
    process.stderr.write(
      `${JSON.stringify({ result: "FAIL", stage, reason: error instanceof SmokeFailure ? error.message : "Agent or transport request failed", ...report })}\n`
    )
    process.exitCode = 1
  } finally {
    for (const other of otherSessions)
      if (adapter.isConnected())
        await bounded(adapter.deleteSession(other), 10_000, "MCP cleanup").catch(() => undefined)
    if (sessionId && adapter.isConnected())
      await bounded(adapter.deleteSession(sessionId), 10_000, "cleanup").catch(() => undefined)
    await bounded(adapter.disconnect(), 10_000, "disconnect").catch(() => undefined)
    selectCliAgentWorkspace(original)
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}
void main().catch(() => {
  process.stderr.write('{"result":"FAIL","stage":"fixture setup"}\n')
  process.exitCode = 1
})
