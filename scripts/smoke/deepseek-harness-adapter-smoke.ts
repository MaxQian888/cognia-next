/** Offline provider fixture with real DSH/Pi, Cognia adapters and tool hosts. */
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { NodeExternalAgentBackend } from "@/cli/src/runtime/external/node-backend"
import { DshSdkClientAdapter } from "@/lib/ai/agent/external/dsh-sdk-client"
import { OpenCodeV2ClientAdapter } from "@/lib/ai/agent/external/opencode-v2-client"
import { launchOpenCodeV2Service } from "@/lib/ai/agent/external/opencode-v2-launcher"
import { buildGatewayTaskConfig } from "@/lib/ai/agent/external/gateway-task"
import { prepareGatewayTask } from "@/cli/src/runtime/external/gateway-task"
import { PiRpcClientAdapter } from "@/lib/ai/agent/external/pi-rpc-client"
import { verifyPiExtension } from "@/cli/src/agent/tool-host/pi-extension"
import {
  createDshRuntimeTransport,
  resolveDshLaunchFromConfig,
} from "@/lib/ai/agent/external/dsh-runtime-transport"
import { buildDshLaunchSpec } from "@/lib/ai/agent/external/dsh-runtime-install"
import type { ExternalAgentConfig, ExternalAgentEvent } from "@/types/agent/external-agent"
import { startToolHostBroker } from "@/cli/src/agent/tool-host/broker"
import { buildToolHostMcpServers } from "@/cli/src/agent/tool-host/spawn"
import { createHostToolExecutor } from "@/cli/src/agent/tool-host/host-tools"
import { useAskUserStore } from "@/stores/agent/ask-user-store"
import type { ResolvedCliSessionContext } from "@/cli/src/agent/session-context"
import { DEFAULT_BUILTIN_TOOLS } from "@cognia/agent-config-types"
import type { ClaudeEvent, SendOptions, ToolHostEvent } from "@cognia/agent-config-types"
import { createSidecarFeatureCallClient, callSidecarToolHost } from "@/lib/claude/feature-call"
import { createRendererToolHost } from "@/lib/ai/agent/external/renderer-tool-host"

async function main() {
  const pi = process.argv.includes("--pi")
  const opencode = process.argv.includes("--opencode")
  const installed = path.resolve(process.argv[2] ?? "")
  if (!pi && !opencode)
    assert.ok(
      process.argv[2] && fs.existsSync(path.join(installed, "node_modules/@deepseek-ai/dsh")),
      "Pass an installed latest managed runtime directory"
    )
  const source = path.resolve("runtime/deepseek-harness")
  const { createMockDeepSeek } = await import(
    pathToFileURL(path.join(source, "mock-deepseek.mjs")).href
  )
  let parityWorkspace = ""
  let extraRoot = ""
  const toolSteps = () =>
    [
      ["mcp__cognia-tools__read", { file_path: path.join(parityWorkspace, "README.md") }],
      [
        "mcp__cognia-tools__file_append",
        {
          path: path.join(parityWorkspace, "SMOKE.txt"),
          content: "Cognia tool bridge wrote this.",
        },
      ],
      [
        "mcp__cognia-plugin-tools__ask_user",
        { question: "Continue the local fixture?", options: [{ value: "yes", label: "Yes" }] },
      ],
      ["mcp__cognia-tools__read", { file_path: path.join(extraRoot, "EXTRA.txt") }],
      [
        "mcp__cognia-tools__file_append",
        { path: path.join(parityWorkspace, "DENIED.txt"), content: "must not exist" },
      ],
    ] as const
  const backend = await createMockDeepSeek({
    reply: (body: {
      messages?: Array<{ role: string; content?: unknown }>
      tools?: Array<{ function: { name: string } }>
    }) => {
      const refreshIndex = pi
        ? (body.messages?.findLastIndex(
            (message) =>
              message.role === "user" &&
              JSON.stringify(message.content).includes("PI_CONTEXT_REFRESH")
          ) ?? -1)
        : -1
      if (refreshIndex >= 0) {
        const system = JSON.stringify(body.messages?.filter((message) => message.role === "system"))
        assert.ok(
          system.includes("Fresh skill instructions"),
          "Refreshed skill instructions were lost"
        )
        assert.ok(system.includes("Fresh semantic task"), "Refreshed task context was lost")
        assert.ok(!system.includes("private-routing-trace"), "Routing trace reached model")
        if (body.messages?.slice(refreshIndex + 1).some((message) => message.role === "tool"))
          return { content: "Cognia smoke completed." }
        const name = "mcp__cognia-tools__read"
        assert.ok(
          body.tools?.some((tool) => tool.function.name === name),
          "Fresh renderer MCP catalog was lost"
        )
        return {
          tool_calls: [
            {
              index: 0,
              id: "fresh-read",
              type: "function",
              function: {
                name,
                arguments: JSON.stringify({ file_path: path.join(parityWorkspace, "README.md") }),
              },
            },
          ],
        }
      }
      if (!JSON.stringify(body.messages).includes("COGNIA_TOOL_PARITY"))
        return { content: "Cognia smoke completed." }
      const step = body.messages?.filter((message) => message.role === "tool").length ?? 0
      const expected = toolSteps()[step]
      const request =
        expected &&
        ([
          opencode ? expected[0].replace(/^mcp__/, "").replace("__", "_") : expected[0],
          expected[1],
        ] as const)
      if (!request) return { content: "Cognia smoke completed." }
      assert.ok(
        body.tools?.some((tool) => tool.function.name === request[0]),
        `Missing Cognia tool: ${request[0]}`
      )
      return {
        tool_calls: [
          {
            index: 0,
            id: `cognia-${step}`,
            type: "function",
            function: { name: request[0], arguments: JSON.stringify(request[1]) },
          },
        ],
      }
    },
  })
  const dataRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cognia-dsh-adapter-")))
  const runtimeHome = path.join(dataRoot, "deepseek-harness")
  const workspace = path.join(dataRoot, "workspaces")
  fs.mkdirSync(runtimeHome)
  fs.mkdirSync(workspace)
  parityWorkspace = workspace
  extraRoot = path.join(dataRoot, "extra-root")
  fs.mkdirSync(extraRoot)
  fs.writeFileSync(path.join(workspace, "README.md"), "Cognia read fixture.")
  fs.writeFileSync(path.join(extraRoot, "EXTRA.txt"), "Cognia additional root fixture.")
  if (!pi && !opencode)
    fs.symlinkSync(
      path.join(installed, "node_modules"),
      path.join(runtimeHome, "node_modules"),
      "dir"
    )
  for (const name of pi || opencode ? [] : ["launcher.mjs", "host.sdk-readonly.yml"])
    fs.copyFileSync(path.join(source, name), path.join(runtimeHome, name))
  const host = new NodeExternalAgentBackend({
    workspacesRoot: workspace,
    // This smoke verifies protocol/process routing. OS sandbox certification is
    // separate; DSH's own read-only profile remains active inside the child.
    resolveLaunch: async (config) => ({ command: config.command, args: config.args ?? [] }),
  })
  const launch = buildDshLaunchSpec({
    paths: {
      runtimeHome,
      workspace,
      launcherPath: path.join(runtimeHome, "launcher.mjs"),
      compositionPath: path.join(runtimeHome, "host.sdk-readonly.yml"),
      dshHome: path.join(runtimeHome, "dsh-home"),
      sessionRoot: path.join(runtimeHome, "sessions"),
    },
    apiKey: "cognia-smoke-placeholder",
    parentEnv: { PATH: process.env.PATH },
    nodePath: process.execPath,
  })
  const config = {
    id: "dsh-adapter-smoke",
    name: "DeepSeek Harness smoke",
    protocol: "dsh-sdk",
    transport: "stdio",
    enabled: true,
    defaultPermissionMode: "plan",
    metadata: { dshProfileId: "cognia-sdk-readonly" },
    process: {
      ...launch,
      cwd: workspace,
      env: { ...launch.env, DEEPSEEK_BASE_URL: backend.baseURL },
    },
    createdAt: new Date(),
    updatedAt: new Date(),
    timeout: 20000,
  } satisfies ExternalAgentConfig
  let stagedExtension: string | undefined
  if (pi) {
    const { stagePiExtension } = await import(
      pathToFileURL(path.resolve("scripts/build/lib/stage-pi-extension.mjs")).href
    )
    const staged = await stagePiExtension({
      root: process.cwd(),
      sidecarOutDir: path.join(runtimeHome, "sidecar"),
    })
    stagedExtension = staged.files[0]
    fs.writeFileSync(
      path.join(runtimeHome, "models.json"),
      JSON.stringify({
        providers: {
          cognia: {
            baseUrl: backend.baseURL,
            api: "openai-completions",
            apiKey: "local-fixture",
            models: [
              {
                id: "smoke",
                reasoning: false,
                input: ["text"],
                contextWindow: 128000,
                maxTokens: 8192,
              },
            ],
          },
        },
      })
    )
  }
  let agentConfig: ExternalAgentConfig = pi
    ? {
        ...config,
        id: "pi-cognia-smoke",
        name: "Pi Cognia smoke",
        protocol: "pi-rpc",
        metadata: { piExtensionPolicy: "isolated" },
        process: {
          command: "pi",
          args: ["--mode", "rpc", "--provider", "cognia", "--model", "smoke"],
          cwd: workspace,
          env: { HOME: dataRoot, PI_CODING_AGENT_DIR: runtimeHome, PATH: process.env.PATH ?? "" },
        },
      }
    : config
  if (opencode) {
    agentConfig = buildGatewayTaskConfig({
      config: {
        ...config,
        protocol: "opencode-v2",
        transport: "sse",
        process: { command: "opencode", cwd: workspace },
        metadata: { preset: "opencode-v2-service" },
      },
      binding: { providerId: "fixture", modelId: "smoke" },
      taskId: "opencode-smoke",
      endpoint: backend.baseURL,
      secret: "local-fixture",
      model: "smoke",
      settings: { providerSettings: {}, customProviders: [] },
      ownerAccountId: null,
      modelMetadata: {
        id: "smoke",
        contextLength: 128000,
        maxOutputTokens: 8192,
        supportsTools: true,
      },
    }).config
  }
  const makeAdapter = () =>
    opencode
      ? new OpenCodeV2ClientAdapter((config, servers, cwd, signal) =>
          launchOpenCodeV2Service(config, servers, cwd, signal, {
            available: () => true,
            listen: async (name, callback) => host.listen(name, callback),
            invoke: async (name, args) => {
              if (name === "spawn_external_agent") {
                const prepared = prepareGatewayTask(
                  args.config as Parameters<typeof prepareGatewayTask>[0],
                  dataRoot
                )
                return host.invoke(name, { ...args, config: prepared.config })
              }
              return host.invoke(name, args)
            },
          })
        )
      : pi
        ? new PiRpcClientAdapter({
            host: {
              invoke: async <T>(name: string, args: Record<string, unknown>): Promise<T> =>
                name === "resolve_pi_extension"
                  ? (verifyPiExtension({
                      env: { NODE_ENV: "test", COGNIA_PI_EXTENSION_PATH: stagedExtension },
                    }) as T)
                  : host.invoke<T>(name, args),
              listen: async <T>(name: string, callback: (payload: T) => void) =>
                host.listen<T>(name, (payload) => {
                  if (process.env.COGNIA_PI_SMOKE_DEBUG && /stdout|stderr/.test(name))
                    process.stderr.write(`[pi-smoke ${name}] ${JSON.stringify(payload)}\n`)
                  callback(payload)
                }),
            },
          })
        : new DshSdkClientAdapter({
            createTransport: (config) =>
              createDshRuntimeTransport(config, resolveDshLaunchFromConfig, true, {
                invoke: (name, args) => host.invoke(name, args),
                listen: async (name, callback) => host.listen(name, callback),
              }),
          })
  if (pi && process.env.COGNIA_PI_SMOKE_DEBUG)
    host.listen("external-agent://stderr", (payload) =>
      process.stderr.write(`[pi-stderr] ${JSON.stringify(payload)}\n`)
    )
  let adapter = makeAdapter()
  let broker: Awaited<ReturnType<typeof startToolHostBroker>> | undefined
  let rendererHost: ReturnType<typeof createRendererToolHost> | undefined
  let sidecar: ReturnType<typeof spawn> | undefined
  const unsubscribeAsk = useAskUserStore.subscribe((state) => {
    if (state.active) state.resolveActive({ selected: ["yes"], text: "", cancelled: false })
  })
  try {
    await adapter.connect(agentConfig)
    const first = await adapter.createSession({ cwd: workspace, permissionMode: "plan" })
    const second = await adapter.createSession({ cwd: workspace, permissionMode: "plan" })
    async function prompt(sessionId: string, text: string) {
      const events: ExternalAgentEvent[] = []
      for await (const event of adapter.prompt(
        sessionId,
        { id: text, role: "user", content: [{ type: "text", text }], timestamp: new Date() },
        { timeout: 20000 }
      )) {
        events.push(event)
        if (event.type === "permission_request")
          await adapter.respondToPermission(sessionId, {
            requestId: event.request.id,
            granted: true,
          })
      }
      assert.ok(
        events.every((event) => event.sessionId === undefined || event.sessionId === sessionId),
        "Session event routing crossed streams"
      )
      const done = events.filter((event) => event.type === "done")
      assert.equal(done.length, 1, "Each prompt must terminate once")
      assert.equal(
        done[0].success,
        true,
        JSON.stringify(events.filter((event) => event.type === "error" || event.type === "done"))
      )
      assert.ok(
        JSON.stringify(events).includes("Cognia smoke completed."),
        "Committed assistant content was lost"
      )
      return events.length
    }
    const counts = await Promise.all([
      prompt(first.id, "First session"),
      prompt(second.id, "Second session"),
    ])
    counts.push(await prompt(first.id, "Followup message"))
    assert.ok(opencode ? backend.requests.length >= 3 : backend.requests.length === 3)
    await adapter.disconnect()
    assert.equal(adapter.isConnected(), false)
    adapter = makeAdapter()
    await adapter.connect(agentConfig)
    const reconnected = await adapter.createSession({ cwd: workspace, permissionMode: "plan" })
    assert.notEqual(reconnected.id, first.id)
    counts.push(await prompt(reconnected.id, "After reconnect"))
    assert.ok(opencode ? backend.requests.length >= 4 : backend.requests.length === 4)
    const toolResults: Array<{ name: string; ok: boolean; summary?: string }> = []
    const approvals: string[] = []
    const brokerSession = {
      sessionId: "dsh-broker-smoke",
      cwd: workspace,
      additionalDirectories: [extraRoot],
      mcpServers: [],
      agents: [],
      subagentToolEnabled: false,
      activeSkillIds: [],
      contextualSkills: [],
      databaseError: null,
      contextVersion: "dsh-parity",
      sendOptions: {
        builtinTools: { ...DEFAULT_BUILTIN_TOOLS, coreFiles: true, fileExtras: true, git: true },
        permissionMode: "default",
        confinement: { enabled: true, roots: [workspace, extraRoot] },
        pluginTools: [
          {
            name: "ask_user",
            description: "Ask the user",
            pluginId: "core",
            jsonSchema: {
              type: "object",
              properties: {
                question: { type: "string" },
                options: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: { value: { type: "string" }, label: { type: "string" } },
                    required: ["value", "label"],
                  },
                },
              },
            },
          },
        ],
      },
    } as ResolvedCliSessionContext
    broker = await startToolHostBroker({
      session: brokerSession,
      attempt: 1,
      socketDir: "/tmp",
      gate: async (request) => {
        approvals.push(request.toolName)
        return JSON.stringify(request.input).includes("DENIED.txt")
          ? { decision: "deny", message: "Fixture denied this write" }
          : { decision: "allow" }
      },
      execHostTool: createHostToolExecutor({ sessionId: brokerSession.sessionId }),
      onToolResult: (event) =>
        toolResults.push({ name: event.name, ok: event.ok, summary: event.summary }),
    })
    const mcpServers = buildToolHostMcpServers({
      endpoint: broker.endpoint,
      token: broker.token,
      packaged: false,
    })
    const toolsSession = await adapter.createSession({
      cwd: workspace,
      permissionMode: "plan",
      mcpServers,
      additionalDirectories: [extraRoot],
      systemPrompt: "Use Cognia tools for this test.",
    })
    counts.push(await prompt(toolsSession.id, "COGNIA_TOOL_PARITY"))
    assert.equal(
      fs.readFileSync(path.join(workspace, "SMOKE.txt"), "utf8"),
      "Cognia tool bridge wrote this."
    )
    assert.equal(fs.existsSync(path.join(workspace, "DENIED.txt")), false)
    assert.ok(toolResults.some((result) => result.name === "read" && result.ok))
    assert.ok(
      toolResults.some((result) => result.name === "ask_user" && result.ok),
      JSON.stringify(toolResults)
    )
    assert.ok(toolResults.some((result) => result.name === "file_append" && result.ok))
    assert.ok(JSON.stringify(backend.requests).includes("Fixture denied this write"))
    assert.ok(JSON.stringify(backend.requests).includes("Cognia additional root fixture."))
    assert.ok(approvals.includes("mcp__cognia-plugin-tools__ask_user"))
    assert.equal(approvals.filter((name) => name === "mcp__cognia-tools__file_append").length, 2)
    // Exercise the desktop helper and real sidecar IPC, with no Tauri mocks in
    // the tool execution path. The parent command forwarding is the sole seam.
    const listeners = new Set<(event: ClaudeEvent) => void>()
    const rendererHookEvents: string[] = []
    sidecar = spawn(process.execPath, [path.resolve("sidecar/agent-host.mjs")], {
      env: {
        NODE_ENV: "test",
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
      },
      stdio: ["pipe", "pipe", "pipe"],
    })
    let sidecarErrors = ""
    sidecar.stderr!.on("data", (chunk) => {
      sidecarErrors += String(chunk)
    })
    const lines = createInterface({ input: sidecar.stdout! })
    const ready = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`Sidecar startup timed out: ${sidecarErrors}`)),
        20_000
      )
      sidecar!.once("exit", (code) => {
        clearTimeout(timeout)
        reject(new Error(`Sidecar exited ${code}: ${sidecarErrors}`))
      })
      lines.on("line", (line) => {
        const event = JSON.parse(line)
        if (
          event.type === "tool_host_event" &&
          ["tool_host_pre_tool", "tool_result_review"].includes(event.event?.type)
        )
          rendererHookEvents.push(event.event.type)
        // This fixture creates no native background jobs; acknowledge the
        // normal Rust-host cleanup RPC and reject any unexpected native call.
        if (event.type === "host_rpc") {
          const known = event.method === "jobs.killOwnedBy"
          sidecar!.stdin!.write(
            `${JSON.stringify({
              type: "host_rpc_result",
              rpcId: event.rpcId,
              ok: known,
              ...(known
                ? { result: {} }
                : { error: `Unexpected fixture host RPC: ${event.method}` }),
            })}\n`
          )
        }
        if (event.type === "ready") {
          clearTimeout(timeout)
          resolve()
        }
        for (const listener of listeners) listener(event)
      })
    })
    await ready
    const client = createSidecarFeatureCallClient({
      call: async (command, args) => {
        const request =
          command === "claude_feature_call"
            ? { type: "feature_call", ...(args?.request as object) }
            : { type: "feature_call_abort", requestId: args?.requestId }
        sidecar!.stdin!.write(`${JSON.stringify(request)}\n`)
      },
      subscribe: (_name, listener) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
      randomUUID: () => crypto.randomUUID(),
    })
    rendererHost = createRendererToolHost("dsh-renderer-smoke", {
      call: (operation, input) => callSidecarToolHost(operation, input, client.requestResult),
      subscribe: (listener) => {
        const handler = (event: ClaudeEvent) => {
          if (event.type === "tool_host_event") listener(event as ToolHostEvent)
        }
        listeners.add(handler)
        return () => {
          listeners.delete(handler)
        }
      },
    })
    const rendererApprovals: string[] = []
    const rendererTools: string[] = []
    const rendererStart = {
      sendOptions: {
        ...brokerSession.sendOptions,
        cwd: workspace,
        additionalDirectories: [extraRoot],
        toolResultReviewEnabled: true,
      } as SendOptions,
      onPermissionRequest: async (request: { toolName: string; input: unknown }) => {
        rendererApprovals.push(request.toolName)
        return JSON.stringify(request.input).includes("DENIED.txt")
          ? { decision: "deny" as const, message: "Fixture denied this write" }
          : { decision: "allow" as const }
      },
      onToolEvent: (event: ExternalAgentEvent) => {
        if (event.type === "tool_result") rendererTools.push(event.toolUseId!)
      },
    }
    const rendererLease = await rendererHost.start(rendererStart)
    fs.unlinkSync(path.join(workspace, "SMOKE.txt"))
    const rendererSession = await adapter.createSession({
      cwd: workspace,
      mcpServers: rendererLease.mcpServers,
    })
    counts.push(await prompt(rendererSession.id, "COGNIA_TOOL_PARITY renderer"))
    assert.equal(
      fs.readFileSync(path.join(workspace, "SMOKE.txt"), "utf8"),
      "Cognia tool bridge wrote this."
    )
    assert.equal(fs.existsSync(path.join(workspace, "DENIED.txt")), false)
    assert.ok(rendererTools.length > 0, "Renderer plugin roundtrip was not observed")
    assert.ok(rendererApprovals.length > 0, "Renderer approval UI callback was bypassed")
    assert.ok(rendererHookEvents.includes("tool_host_pre_tool"), "PreToolUse hook was bypassed")
    assert.ok(rendererHookEvents.includes("tool_result_review"), "PostToolUse hook was bypassed")
    await rendererHost.pause()
    const resumedLease = await rendererHost.start(rendererStart)
    assert.deepEqual(
      resumedLease.mcpServers,
      rendererLease.mcpServers,
      "Conversation endpoint changed between turns"
    )
    counts.push(await prompt(rendererSession.id, "Followup renderer turn"))
    if (pi) {
      await adapter.closeSession(rendererSession.id)
      await rendererHost.close()
      rendererHost = createRendererToolHost("pi-renderer-refresh-smoke", {
        call: (operation, input) => callSidecarToolHost(operation, input, client.requestResult),
        subscribe: (listener) => {
          const handler = (event: ClaudeEvent) => {
            if (event.type === "tool_host_event") listener(event as ToolHostEvent)
          }
          listeners.add(handler)
          return () => {
            listeners.delete(handler)
          }
        },
      })
      const fresh = await rendererHost.start(rendererStart)
      assert.notDeepEqual(
        fresh.mcpServers,
        rendererLease.mcpServers,
        "Fixture did not rotate MCP credentials"
      )
      assert.ok(adapter instanceof PiRpcClientAdapter)
      await adapter.resumeSession(rendererSession.id, {
        cwd: workspace,
        mcpServers: fresh.mcpServers,
      })
      const refreshedEvents: ExternalAgentEvent[] = []
      for await (const event of adapter.prompt(
        rendererSession.id,
        {
          id: "pi-refresh",
          role: "user",
          content: [{ type: "text", text: "PI_CONTEXT_REFRESH" }],
          timestamp: new Date(),
        },
        {
          instructionEnvelope: {
            hash: "fresh-skill",
            developerInstructions: "Fresh skill instructions",
          },
          context: {
            parentTask: "Fresh semantic task",
            custom: { traceId: "private-routing-trace" },
          },
        }
      ))
        refreshedEvents.push(event)
      assert.ok(
        refreshedEvents.some((event) => event.type === "tool_result"),
        "Fresh MCP lease was not called"
      )
      assert.equal(refreshedEvents.filter((event) => event.type === "done").length, 1)
      counts.push(refreshedEvents.length)
    }
    await rendererHost.pause()
    await adapter.disconnect()
    process.stdout.write(
      `${JSON.stringify({ result: "PASS", source: `real ${pi ? "Pi + bundled extension" : opencode ? "OpenCode V2" : "DSH"} + Cognia Node host + protocol adapter + CLI broker + renderer helper + sidecar; local mock provider`, sessions: 5, prompts: pi ? 8 : 7, reconnect: true, toolResults, approvals, rendererApprovals, rendererTools, rendererHookEvents, additionalRoot: true, deniedWrite: true, eventCounts: counts })}\n`
    )
  } finally {
    await adapter.disconnect()
    await rendererHost?.close()
    sidecar?.stdin?.end()
    sidecar?.kill()
    await broker?.close()
    unsubscribeAsk()
    await backend.close()
    fs.rmSync(dataRoot, { recursive: true, force: true })
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
