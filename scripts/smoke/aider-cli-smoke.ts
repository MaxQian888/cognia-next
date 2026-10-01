/** Live official Aider CLI acceptance through Cognia's mandatory sandbox.
 * Needs AIDER_MODEL and provider credentials in the local environment.
 * All edits and Cognia history are confined to a disposable workspace.
 */
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { randomBytes } from "node:crypto"
import { selectCliAgentWorkspace } from "@/cli/src/runtime/external/host-branch"
import { AiderCliClientAdapter } from "@/lib/ai/agent/external/runtimes/aider/aider-cli-client"
import { createAgentFromPreset } from "@/lib/ai/agent/external/config/presets"
import type { ExternalAgentMessage } from "@/types/agent/external-agent"

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}
const message = (text: string): ExternalAgentMessage => ({
  id: `smoke-${randomBytes(5).toString("hex")}`,
  role: "user",
  content: [{ type: "text", text }],
  timestamp: new Date(),
})

async function main() {
  check(process.env.AIDER_MODEL, "Set AIDER_MODEL and provider credentials locally")
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cognia-aider-smoke-")))
  const codeword = `fixture-${randomBytes(6).toString("hex")}`
  const target = path.join(workspace, "greeting.js")
  fs.writeFileSync(target, 'export const greeting = "before";\n', { mode: 0o600 })
  fs.writeFileSync(
    path.join(workspace, ".aider.conf.yml"),
    "load: startup.txt\nfile: [ignored.txt]\n"
  )
  fs.writeFileSync(path.join(workspace, "startup.txt"), "/run touch startup-marker.txt\n")
  fs.writeFileSync(
    path.join(workspace, "ignored.txt"),
    "Synthetic hidden contact alice@example.com\n"
  )
  fs.writeFileSync(
    path.join(workspace, ".env"),
    "DEEPSEEK_API_KEY=fixture-invalid-key\nAIDER_LOAD=startup.txt\n"
  )
  const env: Record<string, string> = {}
  for (const name of [
    "DEEPSEEK_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "OPENROUTER_API_KEY",
    "OPENAI_API_BASE",
  ])
    if (process.env[name]) env[name] = process.env[name]!
  const config = createAgentFromPreset("aider", {
    id: `aider-smoke-${randomBytes(5).toString("hex")}`,
    process: {
      command: "aider",
      cwd: workspace,
      args: ["--model", process.env.AIDER_MODEL, "--edit-format", "diff"],
      env,
    },
    defaultPermissionMode: "bypassPermissions",
    timeout: 120_000,
  })
  const adapter = new AiderCliClientAdapter()
  check(config, "The Aider preset is unavailable")
  try {
    selectCliAgentWorkspace(workspace)
    await adapter.connect(config)
    const session = await adapter.createSession({ cwd: workspace })
    const first = await adapter.execute(
      session.id,
      message(
        `Remember the codeword ${codeword}. In greeting.js change the string "before" to "after". Keep the rest unchanged.`
      ),
      { files: [{ path: "greeting.js" }] }
    )
    check(
      first.success,
      `File edit failed: ${first.error ?? "no success"}; ${first.finalResponse?.slice(-2000) ?? ""}`
    )
    check(
      fs.readFileSync(target, "utf8").includes('"after"'),
      "Aider did not apply the requested edit"
    )
    process.stdout.write("PASS official CLI file edit and streamed response\n")
    check(
      !fs.existsSync(path.join(workspace, "startup-marker.txt")),
      "Native startup commands escaped isolation"
    )
    process.stdout.write("PASS implicit native config and dotenv isolation\n")

    const second = await adapter.execute(
      session.id,
      message("What codeword did I ask you to remember? Reply with that codeword only.")
    )
    check(
      second.success && second.finalResponse?.includes(codeword),
      `Multi-turn history failed: ${second.error ?? "codeword missing"}`
    )
    process.stdout.write("PASS isolated multi-turn Aider history\n")

    const beforePlan = fs.readFileSync(target, "utf8")
    const plan = await adapter.execute(
      session.id,
      message('Change greeting.js to export greeting = "forbidden".'),
      { permissionMode: "plan", files: [{ path: "greeting.js" }] }
    )
    check(plan.success, `Read-only turn failed: ${plan.error}`)
    check(fs.readFileSync(target, "utf8") === beforePlan, "Plan mode changed a source file")
    process.stdout.write("PASS read-only plan mode\n")

    await adapter.disconnect()
    await adapter.connect(config)
    await adapter.resumeSession(session.id, { cwd: workspace })
    const resumed = await adapter.execute(
      session.id,
      message("Reply with the original remembered codeword only.")
    )
    check(
      resumed.success && resumed.finalResponse?.includes(codeword),
      `History recovery failed: ${resumed.error ?? "codeword missing"}`
    )
    process.stdout.write("PASS reconnect and Cognia-owned history recovery\n")

    const sibling = await adapter.createSession({ cwd: workspace })
    const cancelSession = await adapter.createSession({ cwd: workspace })
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let observedCancellation = false
    const cancelled = await adapter.execute(
      cancelSession.id,
      message("Explain in detail how a compiler works, with at least twenty paragraphs."),
      {
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type === "message_start") timer = setTimeout(() => controller.abort(), 350)
          if (event.type === "done" && event.stopReason === "cancelled") observedCancellation = true
        },
      }
    )
    if (timer) clearTimeout(timer)
    check(
      !cancelled.success && observedCancellation,
      "Cancellation did not settle the process-backed turn"
    )
    process.stdout.write("PASS process cancellation\n")

    await adapter.deleteSession(session.id)
    check(
      !fs.readdirSync(workspace).some((name) => name.includes(session.id)),
      "Session deletion left history behind"
    )
    check(
      fs.readdirSync(workspace).some((name) => name.includes(sibling.id)),
      "Session deletion removed sibling state"
    )
    process.stdout.write("PASS scoped session deletion and sibling isolation\n")
  } finally {
    await adapter.disconnect()
    fs.rmSync(workspace, { recursive: true, force: true })
  }
}
main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
