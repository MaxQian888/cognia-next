/**
 * Tests for the computer-use plugin's activate() / deactivate() lifecycle
 * focused on the plugin-tool registration path. The slash-command + i18n
 * paths already existed before this change and are covered indirectly
 * through host integration tests.
 *
 * We mock `lib/automation/anthropic-action-mapper` and
 * `lib/automation/plugin-tauri` so the executor callbacks can be
 * inspected without driving real Tauri commands.
 */

jest.mock("@/lib/automation/anthropic-action-mapper", () => ({
  dispatchAnthropicAction: jest.fn(),
}))

jest.mock("@/lib/automation/plugin-tauri", () => ({
  pluginComputerUseBash: jest.fn(),
  pluginComputerUseTextEditor: jest.fn(),
}))

jest.mock("@/lib/chat/slash-command-registry", () => ({
  registerSlashCommand: jest.fn(),
  unregisterCommandsByPlugin: jest.fn(),
}))

jest.mock("@/lib/i18n/plugin-i18n-registry", () => ({
  registerPluginI18n: jest.fn(),
  unregisterPluginI18n: jest.fn(),
}))

import definition from "./index"
import { registerSlashCommand, unregisterCommandsByPlugin } from "@/lib/chat/slash-command-registry"
import { registerPluginI18n, unregisterPluginI18n } from "@/lib/i18n/plugin-i18n-registry"
import { dispatchAnthropicAction } from "@/lib/automation/anthropic-action-mapper"
import { pluginComputerUseBash, pluginComputerUseTextEditor } from "@/lib/automation/plugin-tauri"

const mockedDispatchAction = dispatchAnthropicAction as jest.Mock
const mockedBash = pluginComputerUseBash as jest.Mock
const mockedTextEditor = pluginComputerUseTextEditor as jest.Mock

type ToolArg = Parameters<NonNullable<MockAgentCtx["agent"]>["registerTool"]>[0]

interface MockAgentCtx {
  pluginId: string
  logger?: { info: jest.Mock; warn: jest.Mock }
  agent?: {
    registerTool: jest.Mock<void, [ToolArg]>
    unregisterTool: jest.Mock<void, [string]>
  }
}

function buildCtx(opts: { withAgent?: boolean } = {}): MockAgentCtx {
  const ctx: MockAgentCtx = {
    pluginId: "cognia-computer-use",
    logger: { info: jest.fn(), warn: jest.fn() },
  }
  if (opts.withAgent !== false) {
    ctx.agent = {
      registerTool: jest.fn(),
      unregisterTool: jest.fn(),
    }
  }
  return ctx
}

afterEach(() => {
  jest.clearAllMocks()
})

describe("computer-use plugin activate()", () => {
  it("registers the slash command and i18n bundle", async () => {
    const ctx = buildCtx()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await definition.activate(ctx as any)
    expect(registerPluginI18n).toHaveBeenCalledWith(
      expect.objectContaining({ pluginId: "cognia-computer-use" })
    )
    expect(registerSlashCommand).toHaveBeenCalledWith(
      expect.objectContaining({ name: "/cu", source: "plugin" })
    )
  })

  it("registers computer_use, bash, and text_editor plugin tools", async () => {
    const ctx = buildCtx()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await definition.activate(ctx as any)
    const calls = ctx.agent!.registerTool.mock.calls.map((c) => c[0])
    expect(calls).toHaveLength(3)
    const names = calls.map((c) => c.name).sort()
    expect(names).toEqual(["bash", "computer_use", "text_editor"])
    for (const c of calls) {
      expect(c.pluginId).toBe("cognia-computer-use")
      expect(c.definition.requiresApproval).toBe(true)
      expect(c.definition.parametersSchema).toBeDefined()
      expect(typeof c.execute).toBe("function")
    }
  })

  it("warns and skips tool registration if ctx.agent is absent", async () => {
    const ctx = buildCtx({ withAgent: false })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await definition.activate(ctx as any)
    expect(ctx.logger!.warn).toHaveBeenCalled()
    // Slash command + i18n still register — the chat-side tool surface is
    // optional, not load-bearing for the rest of the plugin.
    expect(registerSlashCommand).toHaveBeenCalled()
  })

  describe("registered tool executors route correctly", () => {
    async function getTool(name: string): Promise<ToolArg | undefined> {
      const ctx = buildCtx()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await definition.activate(ctx as any)
      return ctx.agent!.registerTool.mock.calls.map((c) => c[0]).find((c) => c.name === name)
    }

    it("computer_use → dispatchAnthropicAction with computerUse surface", async () => {
      const tool = await getTool("computer_use")
      mockedDispatchAction.mockResolvedValueOnce({ ok: true })
      await tool!.execute(
        { action: "screenshot" },
        {
          config: {},
          pluginId: "cognia-computer-use",
        }
      )
      expect(mockedDispatchAction).toHaveBeenCalledWith(
        { action: "screenshot" },
        { surface: "computerUse", pluginId: "cognia-computer-use" }
      )
    })

    it("bash → pluginComputerUseBash with computerUse surface", async () => {
      const tool = await getTool("bash")
      mockedBash.mockResolvedValueOnce({
        stdout: "",
        stderr: "",
        exit_code: 0,
        duration_ms: 0,
      })
      await tool!.execute(
        { command: "ls" },
        {
          config: {},
          pluginId: "cognia-computer-use",
        }
      )
      expect(mockedBash).toHaveBeenCalledWith(
        { command: "ls" },
        { surface: "computerUse", pluginId: "cognia-computer-use" }
      )
    })

    it("text_editor → pluginComputerUseTextEditor with computerUse surface", async () => {
      const tool = await getTool("text_editor")
      mockedTextEditor.mockResolvedValueOnce({ ok: true })
      await tool!.execute(
        { action: "view", path: "/tmp/x" },
        {
          config: {},
          pluginId: "cognia-computer-use",
        }
      )
      expect(mockedTextEditor).toHaveBeenCalledWith(
        { action: "view", path: "/tmp/x" },
        { surface: "computerUse", pluginId: "cognia-computer-use" }
      )
    })
  })
})

describe("computer-use plugin deactivate()", () => {
  it("unregisters commands, i18n, and plugin tools", async () => {
    const ctx = buildCtx()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await definition.deactivate!(ctx as any)
    expect(unregisterCommandsByPlugin).toHaveBeenCalledWith("cognia-computer-use")
    expect(unregisterPluginI18n).toHaveBeenCalledWith("cognia-computer-use")
    const unregistered = ctx.agent!.unregisterTool.mock.calls.map((c) => c[0])
    expect(unregistered.sort()).toEqual(["bash", "computer_use", "text_editor"])
  })

  it("survives without ctx", async () => {
    await expect(definition.deactivate!()).resolves.toBeUndefined()
  })

  it("skips tool unregistration when ctx.agent is absent", async () => {
    const ctx = buildCtx({ withAgent: false })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await definition.deactivate!(ctx as any)
    expect(unregisterCommandsByPlugin).toHaveBeenCalledWith("cognia-computer-use")
  })
})
