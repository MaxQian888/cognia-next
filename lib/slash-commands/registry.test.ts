import {
  registerSlashCommand,
  unregisterSlashCommand,
  unregisterCommandsByPlugin,
  getSlashCommand,
  listSlashCommands,
  listCommandsByPlugin,
  dispatchSlashCommand,
  seedBuiltinSlashCommands,
  __resetSlashCommandsForTesting,
} from "./registry"
import * as canonical from "./registry"
import * as reExport from "@/lib/chat/slash-command-registry"

afterEach(() => {
  __resetSlashCommandsForTesting()
})

describe("slash-command registry (lib/slash-commands/registry)", () => {
  it("register / get round-trips a command", () => {
    const handler = jest.fn(() => ({ message: "ok" }))
    registerSlashCommand({
      id: "git.status",
      name: "Git status",
      handler,
    })
    expect(getSlashCommand("git.status")?.name).toBe("Git status")
  })

  it("registerSlashCommand validates id and handler", () => {
    expect(() => registerSlashCommand({ id: "", name: "x", handler: () => ({}) })).toThrow(
      /id is required/
    )
    expect(() =>
      // @ts-expect-error intentional bad input
      registerSlashCommand({ id: "x", name: "x", handler: 42 })
    ).toThrow(/handler/)
  })

  it("registerSlashCommand reports replacement on duplicate id", () => {
    registerSlashCommand({ id: "x", name: "first", handler: () => ({}) })
    const result = registerSlashCommand({ id: "x", name: "second", handler: () => ({}) })
    expect(result.replaced).toBe(true)
    expect(getSlashCommand("x")?.name).toBe("second")
  })

  it("unregisterSlashCommand drops a single entry", () => {
    registerSlashCommand({ id: "x", name: "x", handler: () => ({}) })
    expect(unregisterSlashCommand("x")).toBe(true)
    expect(unregisterSlashCommand("x")).toBe(false)
    expect(getSlashCommand("x")).toBeUndefined()
  })

  it("unregisterCommandsByPlugin only removes that plugin's commands", () => {
    registerSlashCommand({ id: "a", name: "a", handler: () => ({}), pluginId: "p1" })
    registerSlashCommand({ id: "b", name: "b", handler: () => ({}), pluginId: "p1" })
    registerSlashCommand({ id: "c", name: "c", handler: () => ({}), pluginId: "p2" })
    registerSlashCommand({ id: "d", name: "d", handler: () => ({}) }) // no plugin

    expect(unregisterCommandsByPlugin("p1")).toBe(2)
    expect(getSlashCommand("a")).toBeUndefined()
    expect(getSlashCommand("b")).toBeUndefined()
    expect(getSlashCommand("c")).toBeDefined()
    expect(getSlashCommand("d")).toBeDefined()
  })

  it("listCommandsByPlugin filters by pluginId", () => {
    registerSlashCommand({ id: "a", name: "a", handler: () => ({}), pluginId: "p" })
    registerSlashCommand({ id: "b", name: "b", handler: () => ({}) })
    expect(listCommandsByPlugin("p").map((c) => c.id)).toEqual(["a"])
  })

  it("listSlashCommands returns every registered command", () => {
    registerSlashCommand({ id: "a", name: "a", handler: () => ({}) })
    registerSlashCommand({ id: "b", name: "b", handler: () => ({}) })
    expect(
      listSlashCommands()
        .map((c) => c.id)
        .sort()
    ).toEqual(["a", "b"])
  })

  describe("dispatchSlashCommand", () => {
    it("returns null for non-slash inputs", async () => {
      expect(await dispatchSlashCommand("hello")).toBeNull()
    })

    it("returns null when the command is not registered", async () => {
      expect(await dispatchSlashCommand("/missing arg")).toBeNull()
    })

    it("dispatches the registered handler with parsed args", async () => {
      const handler = jest.fn(async (args) => ({ message: `got: ${args}` }))
      registerSlashCommand({ id: "echo", name: "Echo", handler })
      const result = await dispatchSlashCommand("/echo hello world")
      expect(handler).toHaveBeenCalledWith("hello world", undefined)
      expect(result?.message).toBe("got: hello world")
    })

    it("passes empty args when no payload follows the command", async () => {
      const handler = jest.fn(async () => ({}))
      registerSlashCommand({ id: "ping", name: "Ping", handler })
      await dispatchSlashCommand("/ping")
      expect(handler).toHaveBeenCalledWith("", undefined)
    })

    it("forwards the context object", async () => {
      const handler = jest.fn(async (_args, ctx) => ({ payload: ctx }))
      registerSlashCommand({ id: "ctx", name: "Ctx", handler })
      const result = await dispatchSlashCommand("/ctx", { sessionId: "s1" })
      expect(result?.payload).toEqual({ sessionId: "s1" })
    })
  })

  describe("seedBuiltinSlashCommands", () => {
    it("mirrors active builtins as descriptor entries with source='builtin'", () => {
      seedBuiltinSlashCommands([
        { name: "clear", description: "Clear chat" },
        { name: "help", description: "Show help", argumentHint: "<topic>" },
      ])
      const seeded = listSlashCommands()
      expect(seeded).toHaveLength(2)
      const help = getSlashCommand("help")
      expect(help?.source).toBe("builtin")
      expect(help?.shortcut).toBe("<topic>")
    })

    it("skips disabled builtins", () => {
      seedBuiltinSlashCommands([
        { name: "compact", description: "(pending)", disabled: true },
        { name: "clear", description: "Clear chat" },
      ])
      expect(listSlashCommands().map((c) => c.id)).toEqual(["clear"])
    })

    it("seed handler returns the composer-deferral hint", async () => {
      seedBuiltinSlashCommands([{ name: "clear", description: "Clear chat" }])
      const result = await dispatchSlashCommand("/clear")
      expect(result?.message).toMatch(/built-in chat command/)
    })

    it("is idempotent on repeat calls", () => {
      seedBuiltinSlashCommands([{ name: "clear", description: "Clear chat" }])
      seedBuiltinSlashCommands([{ name: "clear", description: "Clear chat (updated)" }])
      const list = listSlashCommands()
      expect(list).toHaveLength(1)
      expect(list[0].description).toBe("Clear chat (updated)")
    })

    it("forwards the optional category and defaults to 'chat'", () => {
      seedBuiltinSlashCommands([
        { name: "status", description: "Diagnostics", category: "diagnostics" },
        { name: "clear", description: "Clear chat" },
      ])
      expect(getSlashCommand("status")?.category).toBe("diagnostics")
      expect(getSlashCommand("clear")?.category).toBe("chat")
    })
  })
})

describe("re-export from lib/chat/slash-command-registry", () => {
  it("uses the same registry instance as the canonical path", async () => {
    // Importing both side-by-side proves they target the same Map.
    // canonical is the statically imported module
    __resetSlashCommandsForTesting()
    canonical.registerSlashCommand({ id: "shared", name: "Shared", handler: () => ({}) })
    expect(reExport.getSlashCommand("shared")?.id).toBe("shared")
    __resetSlashCommandsForTesting()
  })
})
