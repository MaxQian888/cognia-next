/** Offline provider fixture with real DSH/Pi, Cognia adapters and tool hosts. */
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { execFileSync, spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { NodeExternalAgentBackend } from "@/cli/src/runtime/external/node-backend"
import { DshSdkClientAdapter } from "@cognia/agent-dsh/sdk-client"
import { createProcessPlaneHost } from "@/lib/ai/agent/external/host/process-host"
import { createOpenCodeV2Adapter } from "@/lib/ai/agent/external/integrations/opencode"
import { buildGatewayTaskConfig } from "@/lib/ai/agent/external/config/gateway-task"
import { prepareGatewayTask } from "@/cli/src/runtime/external/gateway-task"
import { PiRpcClientAdapter } from "@cognia/agent-pi/rpc-client"
import { createPiRpcAdapter } from "@/lib/ai/agent/external/integrations/pi"
import { verifyPiExtension } from "@/cli/src/agent/tool-host/pi-extension"
import { createDshRuntimeTransport, resolveDshLaunchFromConfig } from "@cognia/agent-dsh/transport"
import { buildDshLaunchSpec } from "@cognia/agent-dsh/install"
import { hasNoLeakingPiiDeep } from "@cognia/redact"
import type { ExternalAgentConfig, ExternalAgentEvent } from "@/types/agent/external-agent"
import { startToolHostBroker } from "@/cli/src/agent/tool-host/broker"
import { buildToolHostMcpServers } from "@/cli/src/agent/tool-host/spawn"
import { createHostToolExecutor } from "@/cli/src/agent/tool-host/host-tools"
import { useAskUserStore } from "@/stores/agent/ask-user-store"
import type { ResolvedCliSessionContext } from "@/cli/src/agent/session-context"
import { DEFAULT_BUILTIN_TOOLS } from "@cognia/agent-config-types"
import type { ClaudeEvent, SendOptions, ToolHostEvent } from "@cognia/agent-config-types"
import { createSidecarFeatureCallClient, callSidecarToolHost } from "@/lib/claude/feature-call"
import { createRendererToolHost } from "@/lib/ai/agent/external/session/renderer-tool-host"

async function main() {
  const pi = process.argv.includes("--pi")
  const sandbox = pi && process.argv.includes("--sandbox")
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
      const lastUser = body.messages?.findLastIndex((message) => message.role === "user") ?? -1
      const lastText = JSON.stringify(body.messages?.[lastUser]?.content)
      if (pi && lastText?.includes("PI_TRIGGER_TOOL")) {
        if (body.messages?.slice(lastUser + 1).some((message) => message.role === "tool"))
          return { content: "Triggered Cognia tool completed." }
        const name = "mcp__cognia-tools__read"
        assert.ok(body.tools?.some((tool) => tool.function.name === name))
        return {
          tool_calls: [
            {
              index: 0,
              id: "triggered-read",
              type: "function",
              function: {
                name,
                arguments: JSON.stringify({ file_path: path.join(parityWorkspace, "README.md") }),
              },
            },
          ],
        }
      }
      if (pi && lastText?.includes("PI_NATIVE_")) {
        if (body.messages?.slice(lastUser + 1).some((message) => message.role === "tool"))
          return { content: "Cognia smoke completed. Unicode: \u2028 / \u2029 / 中文" }
        if (lastText.includes("PI_NATIVE_PLAN")) {
          for (const name of ["bash", "write", "edit", "codemode"])
            assert.ok(
              !body.tools?.some((tool) => tool.function.name === name),
              `${name} escaped plan floor`
            )
          return { content: "Cognia smoke completed." }
        }
        const cancel = lastText.includes("PI_NATIVE_CANCEL")
        const codemode = lastText.includes("PI_NATIVE_CODEMODE")
        return {
          tool_calls: [
            {
              index: 0,
              id: cancel ? "native-cancel" : "native-write",
              type: "function",
              function: {
                name: codemode ? "codemode" : cancel ? "bash" : "write",
                arguments: JSON.stringify(
                  codemode
                    ? {
                        code: `text(await tools.write(${JSON.stringify({ path: path.join(parityWorkspace, "NESTED.txt"), content: "nested fixture" })}));`,
                      }
                    : cancel
                      ? { command: "sleep 10" }
                      : {
                          path: path.join(parityWorkspace, "NATIVE.txt"),
                          content: "native fixture",
                        }
                ),
              },
            },
          ],
        }
      }
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
  const workspace = path.join(dataRoot, "workspaces")
  const runtimeHome = path.join(sandbox ? workspace : dataRoot, "deepseek-harness")
  fs.mkdirSync(workspace)
  fs.mkdirSync(runtimeHome)
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
    // --pi --sandbox also exercises the production host launcher on this OS.
    // DSH's own read-only profile remains active in the protocol-only mode.
    ...(sandbox
      ? {}
      : {
          resolveLaunch: async (config: { command: string; args?: string[] }) => ({
            command: config.command,
            args: config.args ?? [],
          }),
        }),
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
    outboundGate: hasNoLeakingPiiDeep,
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
      path.join(runtimeHome, "settings.json"),
      JSON.stringify({ defaultTools: ["+codemode"] })
    )
    // A real extension command returns disposition=handled without agent_settled.
    fs.writeFileSync(
      path.join(runtimeHome, "fixture-extension.ts"),
      `
export default function (pi) {
  pi.on("user_bash", () => ({ result: { output: "UNGUARDED_PLUGIN_BYPASS", exitCode: 0, cancelled: false, truncated: false } }));
  pi.registerCommand("cognia-smoke-trigger", { description: "Trigger model work", handler: async (args) => { pi.sendUserMessage(args || "Extension requested work"); } });
  pi.registerCommand("cognia-smoke-handled", {
    description: "Local compatibility fixture",
    handler: async (_args, ctx) => {
      ctx.ui.setStatus("smoke", "Fixture status");
      ctx.ui.setWidget("smoke", ["Fixture line one", "Fixture line two"]);
      ctx.ui.setTitle("Fixture terminal title");
      ctx.ui.setEditorText("Fixture editor text");
      ctx.ui.notify("Handled fixture command", "info");
    },
  });
  pi.registerCommand("cognia-smoke-dialog", {
    description: "Local pre-ack dialog fixture",
    handler: async (_args, ctx) => {
      if (!await ctx.ui.confirm("Fixture confirmation", "Continue?")) throw new Error("Confirmation was not accepted");
      ctx.ui.notify("Dialog fixture completed", "info");
    },
  });
}
`
    )
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
          args: [
            "--mode",
            "rpc",
            "-e",
            "builtin:codemode",
            "--provider",
            "cognia",
            "--model",
            "smoke",
            "-e",
            path.join(runtimeHome, "fixture-extension.ts"),
          ],
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
      ? createOpenCodeV2Adapter(
          createProcessPlaneHost(
            {
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
            },
            () => true
          ),
          { hasSelectedSandbox: () => false, processesLocal: () => true }
        )
      : pi
        ? createPiRpcAdapter(
            createProcessPlaneHost(
              {
                invoke: (name, args) => host.invoke(name, args),
                listen: async (name, callback) =>
                  host.listen(name, (payload) => {
                    if (process.env.COGNIA_PI_SMOKE_DEBUG && /stdout|stderr/.test(name))
                      process.stderr.write(`[pi-smoke ${name}] ${JSON.stringify(payload)}\n`)
                    callback(payload as never)
                  }),
              },
              () => true
            ),
            {
              resolveExtension: async () =>
                verifyPiExtension({
                  env: { NODE_ENV: "test", COGNIA_PI_EXTENSION_PATH: stagedExtension },
                }),
              listSessions: (cwd) => host.invoke("list_pi_sessions", cwd ? { cwd } : {}),
            }
          )
        : new DshSdkClientAdapter({
            createTransport: (config) =>
              createDshRuntimeTransport(
                config,
                resolveDshLaunchFromConfig,
                createProcessPlaneHost(
                  {
                    invoke: (name, args) => host.invoke(name, args),
                    listen: async (name, callback) => host.listen(name, callback),
                  },
                  () => true
                ),
                hasNoLeakingPiiDeep
              ),
          })
  if (pi && process.env.COGNIA_PI_SMOKE_DEBUG)
    host.listen("external-agent://stderr", (payload) =>
      process.stderr.write(`[pi-stderr] ${JSON.stringify(payload)}\n`)
    )
  let adapter = makeAdapter()
  let broker: Awaited<ReturnType<typeof startToolHostBroker>> | undefined
  let rendererHost: ReturnType<typeof createRendererToolHost> | undefined
  let sidecar: ReturnType<typeof spawn> | undefined
  const compatibility: string[] = []
  const piVersion = pi ? execFileSync("pi", ["--version"], { encoding: "utf8" }).trim() : undefined
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
    if (adapter instanceof PiRpcClientAdapter) {
      const piAdapter = adapter
      const collect = async (sessionId: string, text: string, approve: boolean) => {
        const events: ExternalAgentEvent[] = []
        // A prompt ACK deadline does not cover a lost terminal event.
        const timeout = setTimeout(() => {
          void piAdapter.closeSession(sessionId)
        }, 15000)
        try {
          for await (const event of piAdapter.prompt(sessionId, {
            id: text,
            role: "user",
            content: [{ type: "text", text }],
            timestamp: new Date(),
          })) {
            events.push(event)
            if (event.type === "elicitation_request")
              await piAdapter.respondToElicitation({
                requestId: event.request.id,
                action: "accept",
                content: { confirm: true },
              })
            if (event.type === "permission_request")
              await piAdapter.respondToPermission(sessionId, {
                requestId: event.request.id,
                granted: approve,
              })
            if (text === "PI_NATIVE_CANCEL" && event.type === "tool_use_start") {
              await piAdapter.executeSessionCommand(sessionId, "/cognia-smoke-handled")
              const image = {
                data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDUcAAAAASUVORK5CYII=",
                mimeType: "image/png",
              }
              await piAdapter.enqueueSessionInput(
                sessionId,
                { text: "PI_FOLLOWUP_MUST_NOT_RUN", images: [image] },
                "follow_up"
              )
              await piAdapter.enqueueSessionInput(
                sessionId,
                { text: "PI_STEER_MUST_NOT_RUN", images: [image] },
                "steer"
              )
              assert.deepEqual(await piAdapter.clearSessionInputQueue(sessionId), {
                steering: [{ text: "PI_STEER_MUST_NOT_RUN", images: [image] }],
                followUp: [{ text: "PI_FOLLOWUP_MUST_NOT_RUN", images: [image] }],
              })
              await piAdapter.steerTurn(sessionId, "PI_CANCELLED_QUEUE_MUST_NOT_RUN")
              await piAdapter.cancel(sessionId)
            }
          }
        } finally {
          clearTimeout(timeout)
        }
        assert.equal(
          events.filter((event) => event.type === "done").length,
          1,
          `${text} never settled`
        )
        return events
      }
      const catalog = await piAdapter.refreshSessionCommands(reconnected.id)
      assert.ok(
        catalog.some(
          (command) => command.name === "cognia-smoke-handled" && command.supportsDuringExecution
        )
      )
      compatibility.push("runtime extension command discovery")
      const beforeHandled = backend.requests.length
      const handled = await collect(reconnected.id, "/cognia-smoke-handled", false)
      assert.ok(handled.some((event) => event.type === "done" && event.success))
      assert.equal(backend.requests.length, beforeHandled, "Handled command called the provider")
      compatibility.push("extension command without agent_settled")
      assert.deepEqual(
        (
          piAdapter.getSession(reconnected.id)?.metadata?.extensionUi as {
            widgets: Record<string, { lines: string[] }>
          }
        ).widgets.smoke.lines,
        ["Fixture line one", "Fixture line two"]
      )
      assert.equal(
        (piAdapter.getSession(reconnected.id)?.metadata?.extensionUi as { title: string }).title,
        "Fixture terminal title"
      )
      compatibility.push("extension status, widget, title and editor presentation")
      const dialog = await collect(reconnected.id, "/cognia-smoke-dialog", true)
      assert.ok(dialog.some((event) => event.type === "elicitation_request"))
      assert.ok(dialog.some((event) => event.type === "done" && event.success))
      assert.equal(backend.requests.length, beforeHandled)
      compatibility.push("extension dialog before prompt acknowledgement")
      const autonomous: ExternalAgentEvent[] = []
      let finishAutonomous: (() => void) | undefined
      const autonomousDone = new Promise<void>((resolve) => {
        finishAutonomous = resolve
      })
      const stopAutonomous = piAdapter.subscribeSessionEvents(reconnected.id, (event) => {
        autonomous.push(event)
        if (event.type === "done") finishAutonomous?.()
      })
      const triggered = await collect(reconnected.id, "/cognia-smoke-trigger", true)
      if (!JSON.stringify(triggered).includes("Cognia smoke completed.")) {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([
            autonomousDone,
            new Promise((_, reject) => {
              timer = setTimeout(
                () => reject(new Error("Triggered autonomous run never settled")),
                15000
              )
            }),
          ])
        } finally {
          if (timer) clearTimeout(timer)
        }
        assert.ok(
          autonomous.some((event) => event.type === "session_start"),
          "Autonomous run did not announce its start"
        )
        assert.ok(
          JSON.stringify(autonomous).includes("Cognia smoke completed."),
          "Handled command dropped its autonomous model output"
        )
      }
      stopAutonomous()
      compatibility.push(
        "handled extension command hands triggered model work to owned or out-of-band stream"
      )
      assert.equal((await piAdapter.checkProviderAuth("cognia")).status, "ready")
      compatibility.push("read-only provider auth diagnostic")
      const models = await piAdapter.getSessionModels(reconnected.id)
      assert.ok(models.availableModels.some((model) => model.modelId === "cognia/smoke"))
      await piAdapter.setSessionModel(reconnected.id, "smoke")
      assert.equal(
        (await piAdapter.getSessionModels(reconnected.id)).currentModelId,
        "cognia/smoke"
      )
      assert.equal(await piAdapter.setThinkingLevel(reconnected.id, "max"), "off")
      compatibility.push("model catalog, bare model ID, thinking clamp")
      const forked = await piAdapter.forkSession(reconnected.id)
      assert.notEqual(forked.id, reconnected.id)
      await prompt(forked.id, "Forked conversation")
      await piAdapter.closeSession(forked.id)
      compatibility.push("persisted session fork")
      const entries = await piAdapter.getSessionEntries(reconnected.id)
      const userEntry = entries.find((entry) => entry.message?.role === "user")
      assert.ok(userEntry, "Runtime entries lost the user message")
      const tree = await piAdapter.getSessionTree(reconnected.id)
      assert.ok(tree.roots.length > 0 && tree.leafId, "Runtime tree lost the active leaf")
      const branch = await piAdapter.forkSession(reconnected.id, { forkAtEntryId: userEntry.id })
      assert.notEqual(branch.id, reconnected.id)
      assert.equal(piAdapter.getSession(reconnected.id)?.id, reconnected.id)
      await prompt(branch.id, "Fork selected entry")
      await piAdapter.closeSession(branch.id)
      const clone = await piAdapter.cloneSession(reconnected.id)
      await piAdapter.renameSession(clone.id, "Smoke clone")
      assert.equal(piAdapter.getSession(clone.id)?.metadata?.title, "Smoke clone")
      const exported = await piAdapter.exportSessionHtml(clone.id)
      assert.ok(exported.path && fs.existsSync(exported.path), "Native HTML export was not written")
      assert.match(fs.readFileSync(exported.path, "utf8"), /<html/i)
      await piAdapter.closeSession(clone.id)
      compatibility.push("entries, tree, fork at entry, native clone, rename and HTML export")
      await piAdapter.setSessionQueuePolicy(reconnected.id, {
        steering: "all",
        followUp: "one-at-a-time",
      })
      await piAdapter.setSessionRuntimeControls(reconnected.id, {
        autoCompaction: false,
        autoRetry: false,
      })
      const runtimeState = await piAdapter.getSessionRuntimeState(reconnected.id)
      assert.deepEqual(runtimeState.queuePolicy, { steering: "all", followUp: "one-at-a-time" })
      assert.equal(runtimeState.controls.autoCompaction, false)
      assert.equal(runtimeState.controls.autoRetry, false)
      await piAdapter.abortSessionRetry(reconnected.id)
      compatibility.push("queue policies, runtime controls and retry abort")
      const forbiddenShellPath = path.join(workspace, "SHELL-FORBIDDEN.txt")
      const blockedShell = await piAdapter.executeSessionShell(
        reconnected.id,
        `touch '${forbiddenShellPath}'`,
        { onPermissionRequest: async (request) => ({ requestId: request.id, granted: true }) }
      )
      assert.notEqual(blockedShell.exitCode, 0)
      assert.equal(fs.existsSync(forbiddenShellPath), false)
      compatibility.push("direct shell respects plan permission floor")
      await collect(reconnected.id, "PI_NATIVE_PLAN", false)
      compatibility.push("plan tool floor")
      const native = await piAdapter.createSession({ cwd: workspace, permissionMode: "default" })
      const denied = await collect(native.id, "PI_NATIVE_DENY", false)
      assert.ok(denied.some((event) => event.type === "permission_request"))
      assert.equal(fs.existsSync(path.join(workspace, "NATIVE.txt")), false)
      const allowed = await collect(native.id, "PI_NATIVE_ALLOW", true)
      assert.ok(allowed.some((event) => event.type === "permission_request"))
      assert.equal(fs.readFileSync(path.join(workspace, "NATIVE.txt"), "utf8"), "native fixture")
      assert.ok(JSON.stringify(allowed).includes("中文"), "Unicode payload was corrupted")
      compatibility.push("native write deny/approve and Unicode JSONL")
      const nested = await collect(native.id, "PI_NATIVE_CODEMODE", true)
      assert.equal(fs.readFileSync(path.join(workspace, "NESTED.txt"), "utf8"), "nested fixture")
      assert.equal(
        nested.filter((event) => event.type === "permission_request").length,
        2,
        "Codemode bypassed nested permission checks"
      )
      compatibility.push("codemode nested write retains both approval gates")
      await collect(native.id, "PI_NATIVE_CANCEL", true)
      await prompt(native.id, "After cancellation")
      assert.ok(
        !JSON.stringify(backend.requests).includes("PI_CANCELLED_QUEUE_MUST_NOT_RUN"),
        "Cancellation ran queued input"
      )
      compatibility.push("cancel clears steering and next turn recovers")
      assert.ok(!JSON.stringify(backend.requests).includes("PI_FOLLOWUP_MUST_NOT_RUN"))
      assert.ok(!JSON.stringify(backend.requests).includes("PI_STEER_MUST_NOT_RUN"))
      compatibility.push("live extension command and multimodal queue restoration")
      const shellTarget = path.join(workspace, "SHELL.txt")
      const shellCommand = `printf 'approved' > '${shellTarget}'`
      let shellApprovals = 0
      const deniedShell = await piAdapter.executeSessionShell(native.id, shellCommand, {
        onPermissionRequest: async (request) => {
          shellApprovals++
          return { requestId: request.id, granted: false }
        },
      })
      assert.notEqual(deniedShell.exitCode, 0)
      assert.equal(fs.existsSync(shellTarget), false)
      const allowedShell = await piAdapter.executeSessionShell(native.id, shellCommand, {
        onPermissionRequest: async (request) => {
          shellApprovals++
          return { requestId: request.id, granted: true }
        },
      })
      assert.equal(allowedShell.exitCode, 0, allowedShell.output)
      assert.equal(fs.readFileSync(shellTarget, "utf8"), "approved")
      assert.equal(shellApprovals, 2)
      const redactedShell = await piAdapter.executeSessionShell(
        native.id,
        "printf 'smoke.user%sfixture.invalid\\n' '@'",
        { onPermissionRequest: async (request) => ({ requestId: request.id, granted: true }) }
      )
      assert.equal(redactedShell.exitCode, 0, redactedShell.output)
      assert.ok(
        !redactedShell.output.includes("smoke.user@fixture.invalid"),
        "Shell leaked PII before entering context"
      )
      let abortTimer: ReturnType<typeof setTimeout> | undefined
      try {
        const abortedShell = await piAdapter.executeSessionShell(native.id, "sleep 10", {
          onPermissionRequest: async (request) => {
            abortTimer = setTimeout(() => {
              void piAdapter.abortSessionShell(native.id)
            }, 500)
            return { requestId: request.id, granted: true }
          },
        })
        assert.equal(abortedShell.cancelled, true)
      } finally {
        if (abortTimer) clearTimeout(abortTimer)
      }
      compatibility.push("first-handler shell guard defeats earlier configured plugin override")
      compatibility.push("direct shell approval, denial, output redaction and abort")
      await piAdapter.closeSession(native.id)
    }
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
      const triggeredToolEvents: ExternalAgentEvent[] = []
      let finishTriggeredTool: (() => void) | undefined
      const triggeredToolDone = new Promise<void>((resolve) => {
        finishTriggeredTool = resolve
      })
      const stopTriggeredTool = adapter.subscribeSessionEvents(rendererSession.id, (event) => {
        triggeredToolEvents.push(event)
        if (event.type === "done") finishTriggeredTool?.()
      })
      const approvalCount = rendererApprovals.length
      for await (const event of adapter.prompt(rendererSession.id, {
        id: "triggered-tool-command",
        role: "user",
        timestamp: new Date(),
        content: [{ type: "text", text: "/cognia-smoke-trigger PI_TRIGGER_TOOL" }],
      }))
        triggeredToolEvents.push(event)
      let triggeredToolTimer: ReturnType<typeof setTimeout> | undefined
      try {
        if (!JSON.stringify(triggeredToolEvents).includes("Triggered Cognia tool completed."))
          await Promise.race([
            triggeredToolDone,
            new Promise((_, reject) => {
              triggeredToolTimer = setTimeout(
                () => reject(new Error("Triggered tool run never settled")),
                15000
              )
            }),
          ])
      } finally {
        if (triggeredToolTimer) clearTimeout(triggeredToolTimer)
        stopTriggeredTool()
      }
      assert.ok(
        triggeredToolEvents.some((event) => event.type === "tool_result"),
        "Triggered run did not use the renderer tool host"
      )
      assert.ok(JSON.stringify(triggeredToolEvents).includes("Triggered Cognia tool completed."))
      assert.ok(
        rendererApprovals.length > approvalCount,
        "Triggered tool bypassed renderer approval"
      )
      compatibility.push(
        "triggered extension run uses Cognia tool with renderer lease and approval hooks"
      )
      counts.push(triggeredToolEvents.length)
    }
    await rendererHost.pause()
    await adapter.disconnect()
    process.stdout.write(
      `${JSON.stringify({ result: "PASS", source: `real ${pi ? "Pi + bundled extension" : opencode ? "OpenCode V2" : "DSH"} + Cognia Node host + protocol adapter + CLI broker + renderer helper + sidecar; local mock provider`, piVersion, sandbox, compatibility, sessions: pi ? 9 : 5, prompts: pi ? 21 : 7, reconnect: true, toolResults, approvals, rendererApprovals, rendererTools, rendererHookEvents, additionalRoot: true, deniedWrite: true, eventCounts: counts })}\n`
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
