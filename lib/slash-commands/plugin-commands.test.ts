import { pluginSlashCommandsToSlashCommands, getPluginSlashCommands } from "./plugin-commands"
import {
  registerSlashCommand,
  seedBuiltinSlashCommands,
  __resetSlashCommandsForTesting,
} from "./registry"
import type { SlashContext } from "./builtin"

afterEach(() => {
  __resetSlashCommandsForTesting()
  jest.restoreAllMocks()
})

function makeCtx(over: Partial<SlashContext> = {}): SlashContext {
  return {
    args: "",
    activeSessionId: null,
    chatStatus: "idle",
    currentPermissionMode: null,
    startNewSession: jest.fn(),
    openSettings: jest.fn(),
    setPermissionMode: jest.fn(),
    pushSystemMessage: jest.fn(),
    ...over,
  } as SlashContext
}

describe("pluginSlashCommandsToSlashCommands", () => {
  it("maps a plugin definition to the composer SlashCommand shape", () => {
    const [cmd] = pluginSlashCommandsToSlashCommands([
      {
        id: "git-tools.status",
        name: "Git status",
        description: "Show repo status",
        shortcut: "<path>",
        source: "plugin",
        pluginId: "git-tools",
        category: "vcs",
        handler: () => ({}),
      },
    ])
    expect(cmd).toMatchObject({
      name: "git-tools.status",
      description: "Show repo status",
      scope: "plugin",
      category: "vcs",
      argumentHint: "<path>",
    })
    expect(typeof cmd.handler).toBe("function")
  })

  it("defaults category to 'plugins' and tolerates a missing description", () => {
    const [cmd] = pluginSlashCommandsToSlashCommands([
      { id: "x.y", name: "Y", source: "plugin", handler: () => ({}) },
    ])
    expect(cmd.category).toBe("plugins")
    expect(cmd.description).toBe("")
  })

  it("excludes builtin-source definitions (they self-seed → would duplicate)", () => {
    seedBuiltinSlashCommands([{ name: "help", description: "List commands." }])
    registerSlashCommand({ id: "p.one", name: "One", source: "plugin", handler: () => ({}) })
    const mapped = getPluginSlashCommands()
    expect(mapped.map((c) => c.name)).toEqual(["p.one"])
  })
})

describe("plugin command adapter handler", () => {
  it("dispatches through the registry and pushes the returned message", async () => {
    const handler = jest.fn(async (args: string) => ({ message: `ran with: ${args}` }))
    registerSlashCommand({ id: "echo.it", name: "Echo", source: "plugin", handler })
    const [cmd] = getPluginSlashCommands()
    const ctx = makeCtx({ args: "hello", activeSessionId: "s1" })
    await cmd.handler!(ctx)
    expect(handler).toHaveBeenCalledWith("hello", { sessionId: "s1" })
    expect(ctx.pushSystemMessage).toHaveBeenCalledWith("ran with: hello")
  })

  it("does not push a system message when the handler returns no message", async () => {
    registerSlashCommand({
      id: "silent.cmd",
      name: "Silent",
      source: "plugin",
      handler: () => ({}),
    })
    const [cmd] = getPluginSlashCommands()
    const ctx = makeCtx()
    await cmd.handler!(ctx)
    expect(ctx.pushSystemMessage).not.toHaveBeenCalled()
  })
})
