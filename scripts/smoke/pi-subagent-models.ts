/** Real Pi/extension processes against a loopback model fixture. No provider credentials. */
import assert from "node:assert/strict"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { EventEmitter } from "node:events"
import { createServer } from "node:http"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { pathToFileURL } from "node:url"
import type {
  AgentProcessHost,
  AgentProcessOutputEvent,
  AgentProcessExitEvent,
} from "@cognia/agent-contracts/host"
import type { ExternalAgentConfig } from "@cognia/agent-contracts/external-agent"
import { PiRpcClientAdapter } from "../../packages/agent-pi/src/rpc-client"
import { verifyPiExtension } from "../../cli/src/agent/tool-host/pi-extension"
import {
  resolvePiSubagents,
  piSubagentSupport,
} from "../../lib/ai/agent/external/config/pi-subagents"
import {
  buildGatewayTaskConfig,
  nativeSubagentModelBindings,
} from "../../lib/ai/agent/external/config/gateway-task"
import { compileTaskModelPlan } from "../../lib/ai/agent/external/config/model-plan"
import { gatewayModelSlots } from "../../lib/ai/agent/external/config/model-slots"
import {
  prepareGatewayTask,
  gatewayRuntimeEnvironment,
} from "../../cli/src/runtime/external/gateway-task"

async function main() {
  const root = path.resolve(
    ".cache/pi-subagent-models/native",
    new Date().toISOString().replaceAll(":", "-")
  )
  fs.mkdirSync(root, { recursive: true })
  const { stagePiExtension } = await import(
    pathToFileURL(path.resolve("scripts/build/lib/stage-pi-extension.mjs")).href
  )
  const guard = stagePiExtension({ root: process.cwd(), sidecarOutDir: path.join(root, "sidecar") })
    .files[0]
  const reports: unknown[] = []
  for (const family of ["gotgenes", "nico"] as const) {
    const directory = path.join(root, family)
    const workspace = path.join(directory, "workspace")
    const agentDir = path.join(directory, "original-agent")
    const packageName = family === "nico" ? "pi-subagents" : "@gotgenes/pi-subagents"
    const packageSource =
      family === "nico"
        ? path.resolve(
            process.env.NICO_SUBAGENTS_DIR ??
              ".cache/pi-subagent-models/nico-runtime/node_modules/pi-subagents"
          )
        : (process.env.GOTGENES_SUBAGENTS_DIR ??
          path.join(os.homedir(), ".pi/agent/npm/node_modules/@gotgenes/pi-subagents"))
    const manifest = JSON.parse(fs.readFileSync(path.join(packageSource, "package.json"), "utf8"))
    const target = path.join(agentDir, "npm/node_modules", packageName)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.symlinkSync(packageSource, target, "dir")
    fs.mkdirSync(path.join(workspace, ".pi/agents"), { recursive: true })
    fs.writeFileSync(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ packages: [`npm:${packageName}@${manifest.version}`] })
    )
    for (const [name, model] of Object.entries({
      reviewer: "cognia/review",
      worker: undefined,
      parent: "inherit",
      native: "fixture/search",
    })) {
      fs.writeFileSync(
        path.join(workspace, ".pi/agents", `${name}.md`),
        `---\nname: ${name}\ndescription: ${name} fixture\ntools: write\n${model ? `model: ${model}\n` : ""}---\nYou are a fixture child. Complete the supplied task.\n`
      )
    }
    fs.mkdirSync(path.join(agentDir, "agents"), { recursive: true })
    fs.writeFileSync(
      path.join(agentDir, "agents/caller.md"),
      "---\nname: caller\ndescription: Global caller\ntools: write\n---\nComplete the task.\n"
    )
    const deniedFile = path.join(workspace, "must-not-exist.txt")
    const calls: Array<{ model: string; child: boolean; content: string }> = []
    let parentTurns = 0
    let backgroundDone = false
    const childTurns = new Map<string, number>()
    const server = createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(Buffer.from(chunk))
        const body = JSON.parse(Buffer.concat(chunks).toString())
        const messages = body.messages as Array<{ role: string; content: unknown }>
        const latestUser = messages.filter((message) => message.role === "user").at(-1)
        const child = JSON.stringify(latestUser?.content).includes("CHILD_FIXTURE_")
        const text = JSON.stringify(messages)
        calls.push({ model: body.model, child, content: text })
        let tool:
          { id: string; type: string; function: { name: string; arguments: string } } | undefined
        let answer = "FIXTURE_DONE"
        if (child) {
          const key = JSON.stringify(latestUser?.content)
          const count = childTurns.get(key) ?? 0
          childTurns.set(key, count + 1)
          if (
            count === 0 &&
            (body.tools ?? []).some(
              (tool: { function: { name: string } }) => tool.function.name === "write"
            )
          )
            tool = {
              id: `write_${calls.length}`,
              type: "function",
              function: {
                name: "write",
                arguments: JSON.stringify({ path: deniedFile, content: "must be denied" }),
              },
            }
          if (count > 0 && key.includes("CHILD_FIXTURE_background")) backgroundDone = true
          answer = "CHILD_DONE"
        } else {
          const name = ["reviewer", "worker", "parent", "native", "caller", "background"][
            parentTurns++
          ]
          if (name)
            tool = {
              id: `delegate_${parentTurns}`,
              type: "function",
              function: {
                name: "subagent",
                arguments: JSON.stringify(
                  family === "nico"
                    ? {
                        agent: name === "background" ? "reviewer" : name,
                        task: `CHILD_FIXTURE_${name}`,
                        async: name === "background",
                        ...(name === "caller" ? { model: "cognia/search" } : {}),
                      }
                    : {
                        subagent_type: name === "background" ? "reviewer" : name,
                        description: name,
                        prompt: `CHILD_FIXTURE_${name}`,
                        run_in_background: name === "background",
                        ...(name === "caller" ? { model: "cognia/search" } : {}),
                      }
                ),
              },
            }
        }
        if (!child && parentTurns > 6) {
          const deadline = Date.now() + 20000
          while (!backgroundDone && Date.now() < deadline)
            await new Promise((done) => setTimeout(done, 50))
          assert(backgroundDone, "Background child did not finish under Cognia guard")
        }
        const delta = tool
          ? { role: "assistant", tool_calls: [{ ...tool, index: 0 }] }
          : { role: "assistant", content: answer }
        res.writeHead(200, { "Content-Type": "text/event-stream" })
        for (const item of [
          { choices: [{ index: 0, delta, finish_reason: null }] },
          {
            choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          },
        ])
          res.write(
            `data: ${JSON.stringify({ id: "fixture-completion", object: "chat.completion.chunk", created: 1, model: body.model, ...item })}\n\n`
          )
        res.end("data: [DONE]\n\n")
      } catch (error) {
        res.writeHead(500)
        res.end(String(error))
      }
    })
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
    const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
    const source = await resolvePiSubagents(
      {
        id: "pi-fixture",
        name: "Pi fixture",
        enabled: true,
        protocol: "pi-rpc",
        transport: "stdio",
        process: { command: process.env.PI_BIN ?? "pi", cwd: workspace },
        metadata: { preset: "pi" },
        requireApprovalFor: ["write"],
      } as ExternalAgentConfig,
      {
        agentDir: async () => agentDir,
        directoryExists: async (directory) => {
          try {
            return fs.statSync(directory).isDirectory()
          } catch {
            return false
          }
        },
        read: async (filename) => {
          try {
            return fs.readFileSync(filename, "utf8")
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
            throw error
          }
        },
        list: async (dir, recursive) => {
          try {
            return fs
              .readdirSync(dir, { recursive: recursive ?? false, withFileTypes: true })
              .filter((entry) => entry.isFile())
              .map((entry) => path.join(entry.parentPath, entry.name))
          } catch {
            return []
          }
        },
      }
    )
    assert.equal(piSubagentSupport(source)?.family, family)
    const binding = { providerId: "fixture", modelId: "primary" }
    const compiled = compileTaskModelPlan({
      primary: binding,
      slots: gatewayModelSlots(source),
      explicitModels: nativeSubagentModelBindings(source, binding),
      layers: [
        {
          source: "config",
          overrides: {
            version: 1,
            slots: {
              "subagent.default": {
                kind: "cognia",
                binding: { providerId: "fixture", modelId: "default" },
              },
            },
          },
        },
      ],
    })
    assert(compiled.ok)
    const built = buildGatewayTaskConfig({
      config: source,
      binding,
      taskId: "pi-model-probe",
      model: "primary",
      endpoint,
      secret: "loopback-fixture",
      settings: { providerSettings: {}, customProviders: [] },
      ownerAccountId: null,
      modelPlan: compiled.plan,
      modelMetadataById: Object.fromEntries(
        compiled.plan.models.map((id) => [
          id,
          {
            id,
            contextLength: 128000,
            maxOutputTokens: 4096,
            supportsTools: true,
            supportsStreaming: true,
            supportsReasoning: false,
          },
        ])
      ),
    })
    const events = new EventEmitter()
    const children = new Map<string, ChildProcessWithoutNullStreams>()
    const stderr: string[] = []
    const cleanups: Array<() => void> = []
    const on =
      <T>(name: string) =>
      async (listener: (event: T) => void) => {
        events.on(name, listener)
        return () => {
          events.off(name, listener)
        }
      }
    const host: AgentProcessHost = {
      available: true,
      spawn: async (spec) => {
        const staged = prepareGatewayTask(spec, path.join(directory, "task-state"))
        cleanups.push(staged.cleanup)
        const child = spawn(staged.config.command, staged.config.args ?? [], {
          cwd: staged.config.cwd,
          env: { ...gatewayRuntimeEnvironment(process.env), ...staged.config.env },
          stdio: "pipe",
        })
        children.set(spec.id, child)
        child.stdout.on("data", (buffer: Buffer) => {
          events.emit("raw", { processId: spec.id, data: buffer.toString("base64") })
          if (staged.config.args?.includes("--version"))
            events.emit("line", { processId: spec.id, data: buffer.toString() })
        })
        child.stderr.on("data", (buffer: Buffer) => {
          stderr.push(buffer.toString())
          events.emit("stderr", { processId: spec.id, data: buffer.toString() })
        })
        child.on("exit", (code) => events.emit("exit", { processId: spec.id, code }))
        return spec.id
      },
      send: async (id, data) => {
        children.get(id)!.stdin.write(`${data}\n`)
      },
      kill: async (id) => {
        children.get(id)?.kill("SIGTERM")
      },
      commandExists: async () => true,
      onStdoutLine: on<AgentProcessOutputEvent>("line"),
      onStdoutRaw: on<AgentProcessOutputEvent>("raw"),
      onStderr: on<AgentProcessOutputEvent>("stderr"),
      onExit: on<AgentProcessExitEvent>("exit"),
    }
    const adapter = new PiRpcClientAdapter({
      processHost: host,
      hostServices: {
        resolveExtension: async () =>
          verifyPiExtension({ env: { NODE_ENV: "test", COGNIA_PI_EXTENSION_PATH: guard } }),
        listSessions: async () => [],
      },
      outboundGate: () => true,
      approvalPolicy: () => null,
      matchToolPattern: (left, right) => left === right,
      isDisabled: () => false,
      classifySpawnConflict: () => null,
      resolvePiPackages: async () => [],
    })
    const sessionEvents: unknown[] = []
    try {
      await adapter.connect(built.config)
      const session = await adapter.createSession({
        cwd: workspace,
        permissionMode: "dontAsk",
        allowedTools: ["subagent", "write", "read", "grep", "find", "ls"],
      })
      const stream = adapter.prompt(
        session.id,
        {
          id: "parent-probe",
          role: "user",
          content: [{ type: "text", text: "Run the fixture tasks." }],
          timestamp: new Date(),
        },
        { timeout: 60000 }
      )
      for await (const event of stream) sessionEvents.push(event)
      for (const model of ["review", "default", "primary", "search"])
        assert(
          calls.some((call) => call.child && call.model === model),
          `${family} missing child ${model}; inspect ${path.join(directory, "evidence.json")}`
        )
      assert(
        calls.some(
          (call) =>
            call.child && call.content.includes("CHILD_FIXTURE_caller") && call.model === "search"
        ),
        "Global omitted agent ignored its explicit call model"
      )
      assert(
        calls.some(
          (call) =>
            call.child &&
            call.content.includes("CHILD_FIXTURE_background") &&
            call.model === "review"
        ),
        "Background child lost its explicit model"
      )
      assert(backgroundDone, "Background child did not finish")
      assert(!fs.existsSync(deniedFile), "Child write bypassed Cognia permission interception")
      assert(
        calls.some((call) => call.child && call.content.includes("Blocked by Cognia")),
        "No child tool-denial evidence"
      )
      const report = {
        family,
        packageVersion: manifest.version,
        passed: true,
        childModels: calls.filter((call) => call.child).map((call) => call.model),
        deniedWrite: true,
        directory,
      }
      reports.push(report)
      console.log(JSON.stringify(report))
    } finally {
      fs.writeFileSync(
        path.join(directory, "evidence.json"),
        JSON.stringify({ calls, stderr, sessionEvents }, null, 2)
      )
      await adapter.disconnect().catch(() => undefined)
      for (const child of children.values()) child.kill("SIGTERM")
      for (const cleanup of cleanups) cleanup()
      server.closeAllConnections()
      await new Promise<void>((done) => server.close(() => done()))
    }
  }
  fs.writeFileSync(path.join(root, "report.json"), JSON.stringify(reports, null, 2))
}
const timer = setTimeout(() => {
  console.error("Pi child model probe timed out")
  process.exit(1)
}, 120000)
main()
  .then(() => {
    clearTimeout(timer)
  })
  .catch((error) => {
    clearTimeout(timer)
    console.error(error)
    process.exitCode = 1
  })
