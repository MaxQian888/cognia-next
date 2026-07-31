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
    expect(mapped).toHaveLength(1)
  })
})

describe("typed token", () => {
  // The projected `name` IS what the user types. It used to be `def.id`
  // verbatim, which made every declared `name` inert — a plugin registering
  // `{ id: "screenshot.capture", name: "/screenshot" }` was only reachable as
  // `/screenshot.capture`, and a manifest-declared command (namespaced by the
  // manager to `<pluginId>.<commandId>`) would only have been reachable as
  // `/cognia-screenshot.screenshot`. `makePluginHandler` resolves by id, so
  // the token is free to be the friendly one.
  it("prefers the declared name and strips a leading slash", () => {
    registerSlashCommand({
      id: "cognia-screenshot.screenshot",
      name: "/screenshot",
      source: "plugin",
      handler: () => ({}),
    })
    expect(getPluginSlashCommands().map((c) => c.name)).toEqual(["screenshot"])
  })

  it("falls back to the id when the name is absent or not a single token", () => {
    registerSlashCommand({ id: "p.noname", name: "", source: "plugin", handler: () => ({}) })
    registerSlashCommand({
      id: "p.spaced",
      name: "Two Words",
      source: "plugin",
      handler: () => ({}),
    })
    expect(
      getPluginSlashCommands()
        .map((c) => c.name)
        .sort()
    ).toEqual(["p.noname", "p.spaced"])
  })

  it("keeps a colliding command reachable under its id (first wins)", () => {
    // The composer keys its submit-time map by name, so a silent collision
    // would make one command unreachable.
    registerSlashCommand({ id: "a.dup", name: "/dup", source: "plugin", handler: () => ({}) })
    registerSlashCommand({ id: "b.dup", name: "/dup", source: "plugin", handler: () => ({}) })
    const names = getPluginSlashCommands().map((c) => c.name)
    expect(new Set(names).size).toBe(names.length)
    expect(names).toContain("dup")
    expect(names).toContain("b.dup")
  })

  it("still dispatches by id, not by the projected token", async () => {
    const handler = jest.fn(() => ({ message: "ran" }))
    registerSlashCommand({ id: "p.byid", name: "/friendly", source: "plugin", handler })
    const cmd = getPluginSlashCommands().find((c) => c.name === "friendly")!
    const pushSystemMessage = jest.fn()
    await cmd.handler?.({ args: "", pushSystemMessage } as never)
    expect(handler).toHaveBeenCalled()
    expect(pushSystemMessage).toHaveBeenCalledWith("ran")
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
