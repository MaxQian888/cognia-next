import {
  registerSlashCommand,
  unregisterSlashCommand,
  unregisterCommandsByPlugin,
  getSlashCommand,
  listSlashCommands,
  listCommandsByPlugin,
  dispatchSlashCommand,
  seedBuiltinSlashCommands,
  subscribeSlashCommands,
  getSlashCommandsVersion,
  __resetSlashCommandsForTesting,
} from "./registry"
import * as canonical from "./registry"
import * as reExport from "@/lib/chat/slash-command-registry"
import {
  getPluginPointDiagnostics,
  __resetDiagnosticsStoreForTesting,
} from "@/lib/plugin/contracts/diagnostics-store"

afterEach(() => {
  __resetSlashCommandsForTesting()
  __resetDiagnosticsStoreForTesting()
})

describe("subscribeSlashCommands", () => {
  it("notifies subscribers and bumps the version on register / unregister", () => {
    const cb = jest.fn()
    const unsub = subscribeSlashCommands(cb)
    const before = getSlashCommandsVersion()
    registerSlashCommand({ id: "p.one", name: "One", handler: () => ({}), source: "plugin" })
    expect(cb).toHaveBeenCalledTimes(1)
    expect(getSlashCommandsVersion()).toBeGreaterThan(before)
    unregisterSlashCommand("p.one")
    expect(cb).toHaveBeenCalledTimes(2)
    unsub()
    registerSlashCommand({ id: "p.two", name: "Two", handler: () => ({}), source: "plugin" })
    // No further calls after unsubscribe.
    expect(cb).toHaveBeenCalledTimes(2)
  })

  it("bumps the version once for a bulk plugin unregister", () => {
    registerSlashCommand({
      id: "px.a",
      name: "A",
      handler: () => ({}),
      source: "plugin",
      pluginId: "px",
    })
    registerSlashCommand({
      id: "px.b",
      name: "B",
      handler: () => ({}),
      source: "plugin",
      pluginId: "px",
    })
    const cb = jest.fn()
    subscribeSlashCommands(cb)
    unregisterCommandsByPlugin("px")
    expect(cb).toHaveBeenCalledTimes(1)
  })
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

  it("rejects a cross-plugin command-id collision (first-wins) and reports it", () => {
    registerSlashCommand({
      id: "shared",
      name: "first",
      handler: () => ({}),
      source: "plugin",
      pluginId: "p1",
    })
    const result = registerSlashCommand({
      id: "shared",
      name: "second",
      handler: () => ({}),
      source: "plugin",
      pluginId: "p2",
    })
    expect(result.replaced).toBe(false)
    expect(getSlashCommand("shared")?.name).toBe("first")
    expect(getPluginPointDiagnostics("p2").some((d) => d.code === "plugin.conflict.rejected")).toBe(
      true
    )
  })

  it("lets the same plugin refresh its own command id", () => {
    registerSlashCommand({
      id: "own",
      name: "v1",
      handler: () => ({}),
      source: "plugin",
      pluginId: "p1",
    })
    const result = registerSlashCommand({
      id: "own",
      name: "v2",
      handler: () => ({}),
      source: "plugin",
      pluginId: "p1",
    })
    expect(result.replaced).toBe(true)
    expect(getSlashCommand("own")?.name).toBe("v2")
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
      const quickAction = {
        surface: "selection" as const,
        selection: {
          candidateId: "c1",
          sourceApp: "TextEdit",
          origin: "accessibility" as const,
          capturedAt: 1,
          truncated: false,
          contentTypes: [],
          editable: true,
          replaceCapability: "paste" as const,
        },
      }
      const result = await dispatchSlashCommand("/ctx", { sessionId: "s1", quickAction })
      expect(result?.payload).toEqual({ sessionId: "s1", quickAction })
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
