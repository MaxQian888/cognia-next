/**
 * Tests for the Computer Use plugin's thin adapter over the canonical
 * app-session automation client.
 */

// Every double targets the SDK subpath the plugin imports, so this suite
// exercises the published surface rather than the host modules behind it.
jest.mock("@cognia/plugin-sdk/api/automation", () => ({
  desktop: {
    getAppState: jest.fn(),
    listApps: jest.fn(),
    queryElements: jest.fn(),
    expandElement: jest.fn(),
    performAction: jest.fn(),
  },
  getActiveComputerUseSettings: jest.fn(() => null),
}))

jest.mock("@cognia/plugin-sdk/api/slash-command", () => ({
  registerSlashCommand: jest.fn(),
  unregisterSlashCommandsByPlugin: jest.fn(),
}))

jest.mock("@cognia/plugin-sdk/api/i18n", () => ({
  registerPluginI18n: jest.fn(),
  unregisterPluginI18n: jest.fn(),
}))

jest.mock("@cognia/plugin-sdk/api/sandbox", () => ({
  HOST_FALLBACK_RUNTIME_REF: "sandbox-runtime:host-default",
  sandboxSessionRuntime: {
    decorateComputerUseContext: jest.fn(async (_ref: string, context: object) => ({
      ...context,
      sandboxConnectionId: "connection-1",
      sandboxConfine: { writable: ["/workspace"], network: "off" },
    })),
    activeRefForSession: jest.fn(() => undefined),
  },
}))

import definition from "./index"
import { desktop } from "@cognia/plugin-sdk/api/automation"
import {
  registerSlashCommand,
  unregisterSlashCommandsByPlugin as unregisterCommandsByPlugin,
} from "@cognia/plugin-sdk/api/slash-command"
import { registerPluginI18n, unregisterPluginI18n } from "@cognia/plugin-sdk/api/i18n"
import { getActiveComputerUseSettings } from "@cognia/plugin-sdk/api/automation"
import { HOST_FALLBACK_RUNTIME_REF, sandboxSessionRuntime } from "@cognia/plugin-sdk/api/sandbox"
import type { ActionRequest } from "@cognia/plugin-sdk"
import type { PluginTool } from "@cognia/plugin-sdk"
const mockedDesktop = desktop as jest.Mocked<typeof desktop>
/** `ctx.sessions.getCurrentSessionId` — the plugin's only session lookup. */
const mockedGetCurrentSessionId = jest.fn(() => null as string | null)
const mockedGetSettings = getActiveComputerUseSettings as jest.Mock
const mockedDecorate = sandboxSessionRuntime.decorateComputerUseContext as jest.Mock

interface MockAgentContext {
  pluginId: string
  logger?: { info: jest.Mock; warn: jest.Mock }
  sessions?: { getCurrentSessionId: jest.Mock }
  agent?: {
    registerTool: jest.Mock<void, [PluginTool]>
    unregisterTool: jest.Mock<void, [string]>
    context: { registerProvider: jest.Mock }
  }
}

function buildContext(options: { withAgent?: boolean } = {}): MockAgentContext {
  const context: MockAgentContext = {
    pluginId: "cognia-computer-use",
    logger: { info: jest.fn(), warn: jest.fn() },
    sessions: { getCurrentSessionId: mockedGetCurrentSessionId },
  }
  if (options.withAgent !== false) {
    context.agent = {
      registerTool: jest.fn(),
      unregisterTool: jest.fn(),
      context: { registerProvider: jest.fn() },
    }
  }
  return context
}

async function getTool(name: string): Promise<PluginTool> {
  const context = buildContext()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await definition.activate(context as any)
  const tool = context
    .agent!.registerTool.mock.calls.map((call) => call[0])
    .find((candidate) => candidate.name === name)
  if (!tool) throw new Error(`tool not registered: ${name}`)
  return tool
}

afterEach(() => {
  jest.clearAllMocks()
})

describe("computer-use plugin activate()", () => {
  it("declares i18n and leaves manifest commands to the host manager", async () => {
    const context = buildContext()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await definition.activate(context as any)

    const manifest = definition.manifest as {
      i18n?: { locales?: Record<string, Record<string, string>> }
    }
    expect(manifest.i18n?.locales?.en?.["slash.cu.description"]).toBeDefined()
    expect(manifest.i18n?.locales?.["zh-CN"]?.["slash.cu.body"]).toBeDefined()
    expect(registerPluginI18n).not.toHaveBeenCalled()
    expect(registerSlashCommand).not.toHaveBeenCalled()
  })

  it("registers only the canonical app-session tools", async () => {
    const context = buildContext()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await definition.activate(context as any)

    const tools = context.agent!.registerTool.mock.calls.map((call) => call[0])
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "expand_element",
      "get_app_state",
      "list_apps",
      "perform_action",
      "query_elements",
    ])
    for (const tool of tools) {
      expect(tool.pluginId).toBe("cognia-computer-use")
      expect(tool.definition.requiresApproval).toBe(true)
      expect(tool.definition.parametersSchema).toBeDefined()
    }
  })

  it("registers guidance for the app-session state/action loop", async () => {
    const context = buildContext()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await definition.activate(context as any)

    const providers = context.agent!.context.registerProvider.mock.calls.map((call) => call[0])
    expect(providers).toHaveLength(1)
    const text = providers[0].provide()
    expect(text).toMatch(/get_app_state/)
    expect(text).toMatch(/perform_action/)
    expect(text).toMatch(/browser_\*/)
  })

  it("warns when the host cannot register tools", async () => {
    const context = buildContext({ withAgent: false })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await definition.activate(context as any)
    expect(context.logger!.warn).toHaveBeenCalled()
  })

  it("routes all tool calls directly to the canonical client", async () => {
    const state = { sessionId: "automation-session", lineageId: "lineage", revision: 7 }
    const locator = { kind: "bundleId" as const, bundleId: "com.apple.TextEdit" }
    const elementLocator = { nameContains: "Document" }
    const handle = { ...state, index: 4, fingerprint: "fingerprint" }
    const request: ActionRequest = {
      turnToken: "turn-token",
      target: { kind: "element", handle },
      action: { kind: "click" },
      strategy: "semantic",
    }

    const toolContext = {
      config: {},
      sessionId: "chat-session",
      messageId: "message-1",
      sandboxRuntimeRef: "sandbox-runtime:one",
    }
    await (await getTool("list_apps")).execute({}, toolContext)
    await (
      await getTool("get_app_state")
    ).execute({ sessionId: state.sessionId, locator, options: {} }, toolContext)
    await (
      await getTool("query_elements")
    ).execute({ ...state, locator: elementLocator, limit: 40 }, toolContext)
    await (
      await getTool("expand_element")
    ).execute({ handle, continuationToken: "next", limit: 25 }, toolContext)
    await (await getTool("perform_action")).execute({ request }, toolContext)

    const callContext = {
      surface: "computerUse",
      pluginId: "cognia-computer-use",
      sessionKey: "chat-session",
      turnKey: "message-1",
      sandboxConnectionId: "connection-1",
      sandboxConfine: { writable: ["/workspace"], network: "off" },
    }
    expect(mockedDesktop.listApps).toHaveBeenCalledWith(callContext)
    expect(mockedDesktop.getAppState).toHaveBeenCalledWith(
      state.sessionId,
      locator,
      {},
      callContext
    )
    expect(mockedDesktop.queryElements).toHaveBeenCalledWith(state, elementLocator, 40, callContext)
    expect(mockedDesktop.expandElement).toHaveBeenCalledWith(handle, "next", 25, callContext)
    expect(mockedDesktop.performAction).toHaveBeenCalledWith(request, callContext)
    expect(mockedDecorate).toHaveBeenCalledWith(
      "sandbox-runtime:one",
      expect.objectContaining({ sessionKey: "chat-session", turnKey: "message-1" })
    )
  })

  it("binds consent policy to the originating session, not current focus", async () => {
    mockedGetSettings.mockReturnValueOnce({ requireConsent: true })
    const locator = { kind: "displayName" as const, displayName: "TextEdit" }

    await (
      await getTool("get_app_state")
    ).execute(
      { sessionId: "automation-session", locator },
      {
        config: {},
        sessionId: "origin-session",
        sandboxRuntimeRef: "sandbox-runtime:consent",
      }
    )

    expect(mockedGetSettings).toHaveBeenCalledWith("origin-session")
    expect(mockedGetCurrentSessionId).not.toHaveBeenCalled()
    expect(mockedDesktop.getAppState).toHaveBeenCalledWith(
      "automation-session",
      locator,
      undefined,
      {
        surface: "computerUse",
        pluginId: "cognia-computer-use",
        sessionKey: "origin-session",
        forceTier: "perCall",
        sandboxConnectionId: "connection-1",
        sandboxConfine: { writable: ["/workspace"], network: "off" },
      }
    )
  })

  it("recovers the origin session's placement when the envelope ref was dropped", async () => {
    const tool = await getTool("list_apps")
    // A session bound to a REMOTE target must not answer a lost envelope field
    // by driving the operator's own desktop.
    jest
      .mocked(sandboxSessionRuntime.activeRefForSession)
      .mockReturnValueOnce("sandbox-runtime:bound" as never)

    await tool.execute({}, { config: {}, sessionId: "origin-session" })

    expect(jest.mocked(sandboxSessionRuntime.activeRefForSession)).toHaveBeenCalledWith(
      "origin-session"
    )
    expect(mockedDecorate).toHaveBeenCalledWith(
      "sandbox-runtime:bound",
      expect.objectContaining({ surface: "computerUse" })
    )
  })

  it("falls back to the host placement when the caller has no send envelope", async () => {
    const tool = await getTool("list_apps")

    // Workflow nodes, plan steps, External Bridge orchestration and
    // plugin-to-plugin calls reach `invokePluginTool` with no
    // `sandboxRuntimeRef`. They ran on the local desktop before the runtime
    // reference existed and must keep working — the refusal belongs to a
    // *bound* placement that has since gone away, not to a missing envelope.
    await expect(
      tool.execute({}, { config: {}, sessionId: "origin-session" })
    ).resolves.not.toThrow()

    expect(mockedDecorate).toHaveBeenCalledWith(
      HOST_FALLBACK_RUNTIME_REF,
      expect.objectContaining({ surface: "computerUse" })
    )
    expect(mockedDesktop.listApps).toHaveBeenCalled()
  })
})

describe("computer-use plugin deactivate()", () => {
  it("unregisters all canonical tools", async () => {
    const context = buildContext()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await definition.deactivate!(context as any)

    expect(context.agent!.unregisterTool.mock.calls.map((call) => call[0]).sort()).toEqual([
      "expand_element",
      "get_app_state",
      "list_apps",
      "perform_action",
      "query_elements",
    ])
    expect(unregisterCommandsByPlugin).not.toHaveBeenCalled()
    expect(unregisterPluginI18n).not.toHaveBeenCalled()
  })

  it("survives missing context or agent", async () => {
    await expect(definition.deactivate!()).resolves.toBeUndefined()
    const context = buildContext({ withAgent: false })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(definition.deactivate!(context as any)).resolves.toBeUndefined()
  })
})
