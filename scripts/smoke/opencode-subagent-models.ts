/** Real OpenCode processes against a loopback-only deterministic model fixture.
 * Run with OPENCODE_V1_BIN and OPENCODE_V2_BIN, using pnpm exec tsx.
 * No account credentials or remote model calls are used.
 */
import assert from "node:assert/strict"
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from "node:child_process"
import { EventEmitter } from "node:events"
import { createServer } from "node:http"
import { mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { createInterface } from "node:readline"
import type {
  AgentProcessHost,
  AgentProcessOutputEvent,
  AgentProcessExitEvent,
} from "@cognia/agent-contracts/host"
import type { ExternalAgentConfig } from "@cognia/agent-contracts/external-agent"
import { OpenCodeClientAdapter } from "../../packages/agent-opencode/src/client"
import { OpenCodeV2ClientAdapter } from "../../packages/agent-opencode/src/v2-client"
import { createOpenCodeV2Launcher } from "../../packages/agent-opencode/src/v2-launcher"
import {
  buildGatewayTaskConfig,
  openCodeSubagentModelBindings,
} from "../../lib/ai/agent/external/config/gateway-task"
import { compileTaskModelPlan } from "../../lib/ai/agent/external/config/model-plan"
import { gatewayModelSlots } from "../../lib/ai/agent/external/config/model-slots"

async function main() {
  const root = resolve(
    ".cache/opencode-subagent-models",
    new Date().toISOString().replaceAll(":", "-")
  )
  await mkdir(root, { recursive: true })
  const reports: unknown[] = []
  for (const protocol of ["opencode", "acp", "opencode-v2"] as const) {
    const binary =
      protocol === "opencode-v2" ? process.env.OPENCODE_V2_BIN : process.env.OPENCODE_V1_BIN
    assert(binary, `Set ${protocol === "opencode-v2" ? "OPENCODE_V2_BIN" : "OPENCODE_V1_BIN"}`)
    const directory = resolve(root, protocol)
    await mkdir(directory, { recursive: true })
    execFileSync("git", ["init", "--quiet", directory])
    const version = execFileSync(binary, ["--version"], { encoding: "utf8" }).trim()
    const calls: Array<{ model: string; tools: string[]; taskSchema?: unknown }> = []
    let primaryCalls = 0
    const modelServer = createServer(async (request, response) => {
      try {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        const body = JSON.parse(Buffer.concat(chunks).toString())
        const tools = (body.tools ?? []) as Array<{
          function: { name: string; parameters: { properties?: Record<string, unknown> } }
        }>
        calls.push({ model: body.model, tools: tools.map((tool) => tool.function.name) })
        const targets = ["reviewer", "researcher", "fallback"]
        const taskTool =
          tools.find((tool) => tool.function.parameters?.properties?.subagent_type) ??
          tools.find((tool) => /^(task|subagent)$/.test(tool.function.name))
        if (taskTool) calls.at(-1)!.taskSchema = taskTool.function.parameters
        const target = body.model === "primary" && taskTool ? targets[primaryCalls++] : undefined
        const toolCall =
          target && taskTool
            ? {
                id: `call_${primaryCalls}`,
                type: "function",
                function: {
                  name: taskTool.function.name,
                  arguments: JSON.stringify({
                    description: `Probe ${target}`,
                    prompt: "Reply with OK. Do not use tools.",
                    subagent_type: target,
                    agent: target,
                  }),
                },
              }
            : undefined
        if (target && !taskTool)
          throw new Error(
            `Native task tool unavailable: ${JSON.stringify(tools.map((tool) => tool.function))}`
          )
        const finish = toolCall ? "tool_calls" : "stop"
        const message = toolCall
          ? { role: "assistant", content: null, tool_calls: [toolCall] }
          : { role: "assistant", content: "OK" }
        const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
        if (body.stream) {
          response.writeHead(200, { "Content-Type": "text/event-stream" })
          const delta = toolCall
            ? { role: "assistant", tool_calls: [{ ...toolCall, index: 0 }] }
            : { role: "assistant", content: "OK" }
          for (const chunk of [
            { choices: [{ index: 0, delta, finish_reason: null }] },
            { choices: [{ index: 0, delta: {}, finish_reason: finish }], usage },
          ])
            response.write(
              `data: ${JSON.stringify({ id: "chatcmpl-probe", object: "chat.completion.chunk", created: 1, model: body.model, ...chunk })}\n\n`
            )
          response.end("data: [DONE]\n\n")
        } else {
          response.writeHead(200, { "Content-Type": "application/json" })
          response.end(
            JSON.stringify({
              id: "chatcmpl-probe",
              object: "chat.completion",
              created: 1,
              model: body.model,
              choices: [{ index: 0, message, finish_reason: finish }],
              usage,
            })
          )
        }
      } catch (error) {
        response.writeHead(500, { "Content-Type": "application/json" })
        response.end(JSON.stringify({ error: { message: String(error), type: "fixture_error" } }))
      }
    })
    await new Promise<void>((done) => modelServer.listen(0, "127.0.0.1", done))
    const address = modelServer.address() as { port: number }
    const v2 = protocol === "opencode-v2"
    const binding = { providerId: "fixture", modelId: "primary" }
    const source = {
      id: `probe-${protocol}`,
      name: "OpenCode model probe",
      enabled: true,
      protocol,
      transport: protocol === "acp" ? "stdio" : "sse",
      metadata: {
        preset: v2
          ? "opencode-v2-service"
          : protocol === "acp"
            ? "opencode-acp"
            : "opencode-server",
        autoSpawnServer: protocol === "opencode",
      },
      process: {
        command: binary,
        args: protocol === "acp" ? ["acp"] : [],
        cwd: directory,
        env: {
          OPENCODE_CONFIG_CONTENT: JSON.stringify({
            [v2 ? "snapshots" : "snapshot"]: false,
            [v2 ? "agents" : "agent"]: {
              reviewer: { mode: "subagent", description: "Review probe", model: "cognia/review" },
              researcher: {
                mode: "subagent",
                description: "Research probe",
                model: "cognia/search",
              },
              fallback: { mode: "subagent", description: "Fallback probe" },
            },
          }),
        },
      },
    } as ExternalAgentConfig
    const plan = compileTaskModelPlan({
      primary: binding,
      slots: gatewayModelSlots(source),
      explicitModels: openCodeSubagentModelBindings(source, binding.providerId),
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
    assert(plan.ok)
    const prepared = buildGatewayTaskConfig({
      config: source,
      binding,
      taskId: "probe",
      endpoint: `http://127.0.0.1:${address.port}/v1`,
      secret: "fixture-only",
      model: "primary",
      settings: { providerSettings: {}, customProviders: [] },
      ownerAccountId: null,
      modelPlan: plan.plan,
      modelMetadataById: Object.fromEntries(
        plan.plan.models.map((id) => [
          id,
          {
            id,
            contextLength: 64000,
            maxOutputTokens: 4096,
            supportsTools: true,
            supportsStreaming: true,
          },
        ])
      ),
    })
    const env = {
      NODE_ENV: "test" as const,
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR,
      HOME: directory,
      XDG_CONFIG_HOME: resolve(directory, "config"),
      XDG_DATA_HOME: resolve(directory, "data"),
      XDG_CACHE_HOME: resolve(directory, "cache"),
      XDG_STATE_HOME: resolve(directory, "state"),
      OPENCODE_CONFIG_DIR: resolve(directory, "config/opencode"),
      OPENCODE_DISABLE_MODELS_FETCH: "true",
      OPENCODE_DISABLE_AUTOUPDATE: "true",
      ...prepared.config.process!.env,
    }
    const events = new EventEmitter()
    const children = new Map<string, ChildProcessWithoutNullStreams>()
    const stderr: string[] = []
    const on =
      <T>(event: string) =>
      async (listener: (value: T) => void) => {
        events.on(event, listener)
        return () => {
          events.off(event, listener)
        }
      }
    const cleanup = () => {
      for (const child of children.values()) child.kill("SIGTERM")
    }
    process.once("exit", cleanup)
    const host: AgentProcessHost = {
      available: true,
      spawn: async (spec) => {
        const child = spawn(spec.command, spec.args ?? [], {
          cwd: spec.cwd ?? directory,
          env: { ...env, ...spec.env },
          stdio: "pipe",
        })
        children.set(spec.id, child)
        createInterface({ input: child.stdout }).on("line", (data) =>
          events.emit("line", { processId: spec.id, data: data + "\n" })
        )
        child.stdout.on("data", (data) =>
          events.emit("raw", { processId: spec.id, data: String(data) })
        )
        child.stderr.on("data", (data) => {
          stderr.push(String(data))
          events.emit("stderr", { processId: spec.id, data: String(data) })
        })
        child.on("exit", (code) => events.emit("exit", { processId: spec.id, code }))
        return spec.id
      },
      send: async (id, data) => {
        children.get(id)!.stdin.write(data)
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
    const logger = { debug() {}, info() {}, warn() {}, error() {} }
    let adapter: OpenCodeClientAdapter | OpenCodeV2ClientAdapter | undefined
    try {
      if (protocol === "acp") {
        const rpc = spawn(binary, ["acp"], { cwd: directory, env, stdio: "pipe" })
        children.set("acp", rpc)
        rpc.stderr.on("data", (data) => stderr.push(String(data)))
        let next = 1
        const pending = new Map<
          number,
          { resolve: (value: unknown) => void; reject: (reason: unknown) => void }
        >()
        createInterface({ input: rpc.stdout }).on("line", (line) => {
          const msg = JSON.parse(line)
          if (msg.method && msg.id !== undefined)
            rpc.stdin.write(
              JSON.stringify({
                jsonrpc: "2.0",
                id: msg.id,
                result: {
                  outcome: {
                    outcome: "selected",
                    optionId: msg.params.options.find(
                      (option: { kind: string }) => option.kind === "allow_once"
                    )?.optionId,
                  },
                },
              }) + "\n"
            )
          else if (msg.id !== undefined) {
            const p = pending.get(msg.id)
            pending.delete(msg.id)
            if (msg.error) p?.reject(msg.error)
            else p?.resolve(msg.result)
          }
        })
        const call = (method: string, params: unknown) =>
          new Promise<unknown>((done, reject) => {
            const id = next++
            pending.set(id, { resolve: done, reject })
            rpc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
          })
        await call("initialize", {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: "cognia-model-probe", version: "1" },
        })
        const session = (await call("session/new", { cwd: directory, mcpServers: [] })) as {
          sessionId: string
        }
        await call("session/prompt", {
          sessionId: session.sessionId,
          prompt: [
            { type: "text", text: "Delegate to reviewer, researcher and fallback, then finish." },
          ],
        })
      } else {
        const placement = { processesLocal: () => true, hasSelectedSandbox: () => false }
        adapter = v2
          ? new OpenCodeV2ClientAdapter({
              fetch,
              outboundGate: () => true,
              placement,
              discoverService: async () => {
                throw new Error("Unexpected discovery")
              },
              launchService: createOpenCodeV2Launcher(host, placement),
            })
          : new OpenCodeClientAdapter({
              fetch,
              processHost: host,
              outboundGate: () => true,
              logger,
            })
        await adapter.connect(prepared.config)
        const session = await adapter.createSession({
          cwd: directory,
          permissionMode: "bypassPermissions",
        })
        const result = await adapter.execute(
          session.id,
          {
            id: "probe",
            role: "user",
            content: [
              { type: "text", text: "Delegate to reviewer, researcher and fallback, then finish." },
            ],
            timestamp: new Date(),
          },
          { timeout: 60000 }
        )
        assert(result.success, JSON.stringify(result))
      }
      for (const model of ["review", "search", "default"])
        assert(
          calls.some((call) => call.model === model),
          `${protocol} never called ${model}: ${JSON.stringify(calls)}`
        )
      reports.push({
        protocol,
        version,
        passed: true,
        models: calls.map((call) => call.model),
        directory,
      })
      console.log(JSON.stringify(reports.at(-1)))
    } catch (error) {
      await writeFile(
        resolve(directory, "failure.json"),
        JSON.stringify({ error: String(error), calls, stderr }, null, 2)
      )
      throw error
    } finally {
      await adapter?.disconnect().catch(() => undefined)
      for (const child of children.values()) child.kill("SIGTERM")
      process.removeListener("exit", cleanup)
      modelServer.closeAllConnections()
      await new Promise<void>((done) => modelServer.close(() => done()))
    }
  }
  await writeFile(resolve(root, "results.json"), JSON.stringify(reports, null, 2))
}

const timeout = setTimeout(() => {
  console.error("OpenCode model probe timed out")
  process.exit(1)
}, 180000)
main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => clearTimeout(timeout))
