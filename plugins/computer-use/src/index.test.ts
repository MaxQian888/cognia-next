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

jest.mock("@/lib/slash-commands/registry", () => ({
  registerSlashCommand: jest.fn(),
  unregisterCommandsByPlugin: jest.fn(),
}))

jest.mock("@/lib/i18n/plugin-i18n-registry", () => ({
  registerPluginI18n: jest.fn(),
  unregisterPluginI18n: jest.fn(),
}))

// `buildChatCallContext` reads the active session id from the chat store and
// the per-session computer-use settings. Default to "no active session" so the
// existing executor tests see a bare ctx; individual tests override.
jest.mock("@/stores/chat/chat-store", () => ({
  useChatStore: { getState: jest.fn(() => ({ activeSessionId: undefined })) },
}))

jest.mock("@/lib/claude/computer-use-active-settings", () => ({
  getActiveComputerUseSettings: jest.fn(() => null),
}))

import definition from "./index"
import { registerSlashCommand, unregisterCommandsByPlugin } from "@/lib/slash-commands/registry"
import { registerPluginI18n, unregisterPluginI18n } from "@/lib/i18n/plugin-i18n-registry"
import { dispatchAnthropicAction } from "@/lib/automation/anthropic-action-mapper"
import { pluginComputerUseBash, pluginComputerUseTextEditor } from "@/lib/automation/plugin-tauri"
import { useChatStore } from "@/stores/chat/chat-store"
import { getActiveComputerUseSettings } from "@/lib/claude/computer-use-active-settings"
import type { PluginTool } from "@/types/plugin/plugin"

const mockedDispatchAction = dispatchAnthropicAction as jest.Mock
const mockedBash = pluginComputerUseBash as jest.Mock
const mockedTextEditor = pluginComputerUseTextEditor as jest.Mock
const mockedGetState = (useChatStore as unknown as { getState: jest.Mock }).getState
const mockedGetSettings = getActiveComputerUseSettings as jest.Mock

type ToolArg = PluginTool

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
  it("registers the slash command (i18n is now declarative via manifest.i18n)", async () => {
    const ctx = buildCtx()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await definition.activate(ctx as any)
    // ADR-0026 §5 §D — i18n migration: the plugin no longer calls
    // `registerPluginI18n` directly. The strings ship in
    // `manifest.i18n.locales` and `lib/plugin/core/manager.ts` auto-wires
    // them on enable. So this test verifies the slash command is still
    // registered AND the imperative i18n registry is no longer touched.
    expect(registerPluginI18n).not.toHaveBeenCalled()
    expect(registerSlashCommand).toHaveBeenCalledWith(
      expect.objectContaining({ name: "/cu", source: "plugin" })
    )
  })

  it("declares the i18n bundle on the manifest", () => {
    // The host's auto-wire (lib/plugin/core/manager.ts:1057-1071) reads
    // this block during enablePlugin(); verifying the shape here so a
    // future refactor that drops the field gets caught.
    const manifest = definition.manifest as {
      i18n?: { locales?: Record<string, Record<string, string>> }
    }
    expect(manifest.i18n?.locales?.en?.["slash.cu.description"]).toBeDefined()
    expect(manifest.i18n?.locales?.["zh-CN"]?.["slash.cu.body"]).toBeDefined()
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
      await tool!.execute({ action: "screenshot" }, { config: {} })
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
      await tool!.execute({ command: "ls" }, { config: {} })
      expect(mockedBash).toHaveBeenCalledWith(
        { command: "ls" },
        { surface: "computerUse", pluginId: "cognia-computer-use" }
      )
    })

    it("text_editor → pluginComputerUseTextEditor with computerUse surface", async () => {
      const tool = await getTool("text_editor")
      mockedTextEditor.mockResolvedValueOnce({ ok: true })
      await tool!.execute({ action: "view", path: "/tmp/x" }, { config: {} })
      expect(mockedTextEditor).toHaveBeenCalledWith(
        { action: "view", path: "/tmp/x" },
        { surface: "computerUse", pluginId: "cognia-computer-use" }
      )
    })

    it("computer_use stamps screenOffMode + forceTier from active settings", async () => {
      const tool = await getTool("computer_use")
      // Only the executor reads the session/settings, so single-shot
      // overrides line up with the one dispatch below.
      mockedGetState.mockReturnValueOnce({ activeSessionId: "sess-1" })
      mockedGetSettings.mockReturnValueOnce({ screenOffMode: true, requireConsent: true })
      mockedDispatchAction.mockResolvedValueOnce({ ok: true })
      await tool!.execute({ action: "screenshot" }, { config: {} })
      expect(mockedDispatchAction).toHaveBeenCalledWith(
        { action: "screenshot" },
        {
          surface: "computerUse",
          pluginId: "cognia-computer-use",
          sessionKey: "sess-1",
          forceTier: "perCall",
          screenOffMode: true,
        }
      )
    })

    it("computer_use omits screenOffMode when the setting is off", async () => {
      const tool = await getTool("computer_use")
      mockedGetState.mockReturnValueOnce({ activeSessionId: "sess-2" })
      mockedGetSettings.mockReturnValueOnce({ screenOffMode: false })
      mockedDispatchAction.mockResolvedValueOnce({ ok: true })
      await tool!.execute({ action: "screenshot" }, { config: {} })
      expect(mockedDispatchAction).toHaveBeenCalledWith(
        { action: "screenshot" },
        { surface: "computerUse", pluginId: "cognia-computer-use", sessionKey: "sess-2" }
      )
    })
  })
})

describe("computer-use plugin deactivate()", () => {
  it("unregisters commands and plugin tools (i18n teardown handled by manager)", async () => {
    const ctx = buildCtx()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await definition.deactivate!(ctx as any)
    expect(unregisterCommandsByPlugin).toHaveBeenCalledWith("cognia-computer-use")
    // ADR-0026 §5 §D — the plugin no longer calls `unregisterPluginI18n`
    // directly. The manager tears down the manifest.i18n bundle when the
    // plugin disables.
    expect(unregisterPluginI18n).not.toHaveBeenCalled()
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
