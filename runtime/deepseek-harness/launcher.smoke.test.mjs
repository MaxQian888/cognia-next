/** Run from an installed copy of this runtime; no model calls or real key. */
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { createInterface } from "node:readline"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { createMockDeepSeek } from "./mock-deepseek.mjs"

const source = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
// Dependencies must come from the exact managed package installation.
const modules = join(dirname(dirname(dirname(require.resolve("@deepseek-ai/dsh/package.json")))))

for (const profile of ["sdk-readonly", "sdk-workspace", "acp"]) {
  test(
    `official product launcher initializes ${profile} and exits on disconnect`,
    { timeout: 30000 },
    async () => {
      const root = mkdtempSync(join(tmpdir(), "cognia-dsh-smoke-"))
      let child
      let backend
      const requests = []
      try {
        backend = await createMockDeepSeek({
          reply: (input, index) => {
            requests.push(input)
            return (profile === "sdk-readonly" && index <= 2) ||
              (profile !== "sdk-readonly" && index === 1)
              ? {
                  tool_calls: [
                    {
                      index: 0,
                      id: `write-${index}`,
                      type: "function",
                      function: {
                        name: "write",
                        arguments: JSON.stringify({
                          file_path: join(root, "must-not-exist.txt"),
                          content: "forbidden",
                          ...(profile === "acp"
                            ? {
                                sandbox_permissions: "danger-full-access",
                                justification: "Smoke permission must be rejected",
                              }
                            : index === 2
                              ? {
                                  sandbox_permissions: "workspace-write",
                                  justification: "Smoke escalation must fail",
                                }
                              : {}),
                        }),
                      },
                    },
                  ],
                }
              : { content: "Cognia smoke completed." }
          },
        })
        symlinkSync(modules, join(root, "node_modules"), "dir")
        for (const file of ["launcher.mjs", `host.${profile}.yml`])
          copyFileSync(join(source, file), join(root, file))
        // This must never be read by the product CLI; launcher boots inside DSH_HOME.
        writeFileSync(join(root, ".env"), "DSH_HOME=/unmanaged-home\n")
        child = spawn(
          process.execPath,
          [join(root, "launcher.mjs"), join(root, `host.${profile}.yml`)],
          {
            cwd: root,
            env: {
              PATH: process.env.PATH,
              HOME: process.env.HOME,
              DSH_HOME: join(root, "dsh-home"),
              COGNIA_DSH_RUNTIME_HOME: root,
              COGNIA_DSH_WORKSPACE: root,
              DEEPSEEK_API_KEY: "cognia-smoke-placeholder",
              DEEPSEEK_BASE_URL: backend.baseURL,
            },
            stdio: ["pipe", "pipe", "pipe"],
          }
        )
        let stderr = ""
        child.stderr.on("data", (chunk) => {
          stderr += chunk
        })
        const exited = new Promise((resolve) =>
          child.once("exit", (code, signal) => resolve({ code, signal }))
        )
        const lines = createInterface({ input: child.stdout })
        const frames = []
        const responses = new Map()
        const waiting = new Map()
        lines.on("line", (line) => {
          let frame
          try {
            frame = JSON.parse(line)
          } catch {
            assert.fail(`Non-protocol stdout: ${line}`)
          }
          frames.push(frame)
          if (frame.method === "session/request_permission") {
            child.stdin.write(
              JSON.stringify({
                jsonrpc: "2.0",
                id: frame.id,
                result: {
                  outcome: {
                    outcome: "selected",
                    optionId: frame.params.options.find((option) => option.kind === "reject_once")
                      .optionId,
                  },
                },
              }) + "\n"
            )
          }
          if (frame.id !== undefined) {
            responses.set(frame.id, frame)
            waiting.get(frame.id)?.(frame)
          }
        })
        async function request(id, method, params) {
          const reply = new Promise((resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error(`No ${method} response: ${stderr}`)),
              20000
            )
            waiting.set(id, (value) => {
              clearTimeout(timer)
              resolve(value)
            })
            exited.then((status) => {
              clearTimeout(timer)
              reject(new Error(`Exited before ${method}: ${JSON.stringify(status)} ${stderr}`))
            })
          })
          child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
          return await reply
        }
        const params =
          profile === "acp"
            ? {
                protocolVersion: 1,
                clientCapabilities: {},
                clientInfo: { name: "cognia-smoke", version: "1" },
              }
            : {
                cwd: root,
                provider: "deepseek-official",
                model:
                  profile === "sdk-workspace"
                    ? "deepseek-v4-flash-vision-exp"
                    : "deepseek-v4-flash",
              }
        const initialized = await request(1, "initialize", params)
        assert.equal(initialized.error, undefined, JSON.stringify(initialized))
        if (profile === "acp") {
          assert.equal(initialized.result.protocolVersion, 1)
          const session = await request(2, "session/new", { cwd: root, mcpServers: [] })
          assert.equal(session.error, undefined, JSON.stringify(session))
          assert.equal(typeof session.result.sessionId, "string")
          const prompt = await request(3, "session/prompt", {
            sessionId: session.result.sessionId,
            prompt: [{ type: "text", text: "Perform the smoke test." }],
          })
          assert.equal(prompt.error, undefined, JSON.stringify(prompt))
          assert.ok(frames.some((frame) => frame.method === "session/request_permission"))
          assert.equal(existsSync(join(root, "must-not-exist.txt")), false)
          assert.ok(JSON.stringify(frames).includes("Cognia smoke completed."))
        } else {
          assert.equal(initialized.result.serverInfo.name, "deepseek-harness-sdk-runtime")
          const stale = await request(2, "session.prompt", {})
          assert.ok(stale.error, "legacy dotted method must not be accepted")
          const receipt = await request(3, "session/prompt", {
            sessionId: "cognia-smoke",
            contentBlocks: [
              { type: "text", text: "Perform the smoke test." },
              ...(profile === "sdk-workspace"
                ? [
                    {
                      type: "image",
                      mimeType: "image/png",
                      data: "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADklEQVQImWP4DwYMEAoAU7oL9W/sIDEAAAAASUVORK5CYII=",
                    },
                  ]
                : []),
            ],
          })
          assert.equal(receipt.error, undefined, JSON.stringify(receipt))
          assert.equal(typeof receipt.result.messageId, "string")
          const deadline = Date.now() + 15000
          while (
            !frames.some(
              (frame) => frame.method === "session.status" && frame.params.status === "idle"
            )
          ) {
            if (Date.now() >= deadline)
              assert.fail(`No idle status: ${JSON.stringify(frames)} ${stderr}`)
            await new Promise((resolve) => setTimeout(resolve, 20))
          }
          assert.ok(frames.some((frame) => frame.method === "session.event"))
          assert.ok(JSON.stringify(frames).includes("Cognia smoke completed."))
          if (profile === "sdk-readonly") {
            assert.equal(requests.length, 3)
            assert.ok(JSON.stringify(requests[1].messages).includes("read-only"))
            assert.ok(JSON.stringify(requests[2].messages).includes("approval"))
            assert.equal(existsSync(join(root, "must-not-exist.txt")), false)
          }
          if (profile === "sdk-workspace") {
            assert.equal(readFileSync(join(root, "must-not-exist.txt"), "utf8"), "forbidden")
            assert.ok(JSON.stringify(requests[0].messages).includes("image_url"))
          }
          const shutdown = await request(4, "shutdown", {})
          assert.equal(shutdown.error, undefined)
        }
        child.stdin.end()
        const status = await exited
        assert.equal(status.code, 0, stderr)
        assert.equal(status.signal, null)
        const sessionRoot = join(root, "sessions")
        const logs = readdirSync(sessionRoot, { recursive: true }).filter((path) =>
          path.endsWith(".jsonl")
        )
        assert.ok(logs.length > 0, "session persistence must produce a durable log")
        const header = JSON.parse(readFileSync(join(sessionRoot, logs[0]), "utf8").split("\n")[0])
        assert.equal(header.version, 3)
      } finally {
        child?.kill("SIGKILL")
        await backend?.close()
        rmSync(root, { recursive: true, force: true })
      }
    }
  )
}
