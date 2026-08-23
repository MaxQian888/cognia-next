import { spawn } from "node:child_process"
import { Readable, Writable } from "node:stream"
import { client, methods, ndJsonStream } from "@agentclientprotocol/sdk"

const TARGETS = [
  ["gemini", "ACP_GEMINI_COMMAND", "ACP_GEMINI_ENV"],
  ["codex", "ACP_CODEX_COMMAND", "ACP_CODEX_ENV"],
  ["claude", "ACP_CLAUDE_COMMAND", "ACP_CLAUDE_ENV"],
]

const SAFE_ENV_KEYS = ["PATH", "HOME", "USER", "SHELL", "TMPDIR", "LANG", "LC_ALL", "TERM"]

function parseCommand(name) {
  const raw = process.env[name]
  if (!raw) return undefined
  let command
  try {
    command = JSON.parse(raw)
  } catch (error) {
    throw new Error(`${name} must be a JSON array: ${error.message}`)
  }
  if (!Array.isArray(command) || command.length === 0 || command.some((part) => !part)) {
    throw new Error(`${name} must be a non-empty JSON array of strings`)
  }
  return command.map(String)
}

function parseEnvironment(name) {
  const inherited = Object.fromEntries(
    SAFE_ENV_KEYS.flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : []))
  )
  const raw = process.env[name]
  if (!raw) return inherited
  let configured
  try {
    configured = JSON.parse(raw)
  } catch (error) {
    throw new Error(`${name} must be a JSON object: ${error.message}`)
  }
  if (!configured || Array.isArray(configured) || typeof configured !== "object") {
    throw new Error(`${name} must be a JSON object of explicitly selected environment values`)
  }
  return {
    ...inherited,
    ...Object.fromEntries(Object.entries(configured).map(([k, v]) => [k, String(v)])),
  }
}

function withTimeout(promise, label, timeoutMs = 60_000) {
  let timeout
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
        timeoutMs
      )
    }),
  ]).finally(() => clearTimeout(timeout))
}

async function runTarget(name, command, environment) {
  const child = spawn(command[0], command.slice(1), {
    cwd: process.cwd(),
    env: environment,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  })
  let stderr = ""
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-8_192)
  })

  const updates = []
  const app = client({ name: `cognia-${name}-live-smoke` })
    .onNotification(methods.client.session.update, ({ params }) => updates.push(params.update))
    .onRequest(methods.client.session.requestPermission, () => ({
      outcome: { outcome: "cancelled" },
    }))

  const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout))
  try {
    return await withTimeout(
      app.connectWith(stream, async (context) => {
        const initialized = await context.request(methods.agent.initialize, {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: "cognia-live-smoke", version: "1" },
        })
        const session = await context.request(methods.agent.session.new, {
          cwd: process.cwd(),
          mcpServers: [],
        })
        const prompted = await context.request(methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [
            {
              type: "text",
              text: "Reply with exactly ACP smoke ok. Do not use tools or modify files.",
            },
          ],
        })
        return {
          target: name,
          protocolVersion: initialized.protocolVersion,
          sessionId: session.sessionId,
          stopReason: prompted.stopReason,
          updates: updates.length,
        }
      }),
      `${name} ACP smoke`
    )
  } catch (error) {
    const diagnostic = stderr.trim() ? `\nAgent stderr (tail):\n${stderr.trim()}` : ""
    throw new Error(`${error.message}${diagnostic}`)
  } finally {
    if (!child.killed) child.kill("SIGTERM")
  }
}

const configured = TARGETS.flatMap(([name, commandVariable, environmentVariable]) => {
  const command = parseCommand(commandVariable)
  return command ? [{ name, command, environment: parseEnvironment(environmentVariable) }] : []
})

if (configured.length === 0) {
  console.log(
    "ACP live smoke skipped. Set ACP_GEMINI_COMMAND, ACP_CODEX_COMMAND, or ACP_CLAUDE_COMMAND to a JSON argv array."
  )
  process.exit(0)
}

const results = []
for (const target of configured) {
  results.push(await runTarget(target.name, target.command, target.environment))
}
console.log(JSON.stringify(results, null, 2))
