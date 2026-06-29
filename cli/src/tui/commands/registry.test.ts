/**
 * @jest-environment node
 */
import {
  CORE_COMMANDS,
  __resetForTesting,
  getCommand,
  listCommands,
  listVisibleCommands,
  registerCommand,
  registerCommands,
} from "./registry"
import type { CommandDescriptor } from "./types"

const stub = (name: string, over: Partial<CommandDescriptor> = {}): CommandDescriptor => ({
  name,
  description: `the ${name} command`,
  category: "system",
  handler: () => ({ kind: "none" }),
  ...over,
})

describe("command registry", () => {
  beforeEach(() => __resetForTesting())

  it("seeds a non-empty catalog of unique, described, categorised core commands", () => {
    const cmds = listCommands()
    expect(cmds.length).toBeGreaterThan(4)
    const names = cmds.map((c) => c.name)
    expect(new Set(names).size).toBe(names.length)
    for (const c of cmds) {
      // Lowercase words, optionally hyphen-joined (e.g. `output-style`).
      expect(c.name).toMatch(/^[a-z]+(-[a-z]+)*$/)
      expect(c.description.length).toBeGreaterThan(0)
      expect(c.category).toBeTruthy()
    }
  })

  it("includes the core commands in their declared order", () => {
    const names = listCommands().map((c) => c.name)
    expect(names).toEqual(
      expect.arrayContaining(["model", "mode", "sessions", "clear", "help", "exit"])
    )
    // `model` precedes `mode` so the palette prefix-match "mo" stays stable.
    expect(names.indexOf("model")).toBeLessThan(names.indexOf("mode"))
  })

  it("registers the /open and /editor commands in the system category", () => {
    expect(getCommand("open")?.category).toBe("system")
    expect(getCommand("editor")?.category).toBe("system")
  })

  it("resolves a command by name or alias", () => {
    expect(getCommand("clear")?.name).toBe("clear")
    expect(getCommand("new")?.name).toBe("clear")
    expect(getCommand("quit")?.name).toBe("exit")
    expect(getCommand("MODEL")?.name).toBe("model")
    expect(getCommand("frob")).toBeUndefined()
  })

  it("/think opens the effort slider overlay (with /thinking + /effort aliases)", () => {
    const think = getCommand("think")
    expect(think?.name).toBe("think")
    expect(getCommand("thinking")?.name).toBe("think")
    expect(getCommand("effort")?.name).toBe("think")
    const effect = think?.handler?.({
      state: {},
      config: { thinkingLevel: "high" },
      version: "0",
      args: "",
    } as never)
    // Seeded from the persisted level: high → off unchecked, slider index 2.
    expect(effect).toMatchObject({
      kind: "openOverlay",
      overlay: { kind: "effortSlider", off: false, index: 2 },
    })
  })

  it("/settings opens the unified settings panel (with a /config alias)", () => {
    const settings = getCommand("settings")
    expect(settings?.name).toBe("settings")
    expect(getCommand("config")?.name).toBe("settings")
    const effect = settings?.handler?.({
      state: {},
      config: {
        provider: "anthropic",
        permissionMode: "default",
        builtinTools: {},
        providers: {},
        cwd: "/w",
      },
      version: "0",
      args: "",
    } as never)
    expect(effect).toMatchObject({ kind: "openOverlay", overlay: { kind: "settings", section: 0 } })
  })

  it("bare /help opens the category overlay; /help <command> opens a focused detail document", () => {
    const help = getCommand("help")
    const ctx = (args: string) => ({ state: {}, config: {}, version: "0", args }) as never
    expect(help?.handler?.(ctx(""))).toMatchObject({
      kind: "openOverlay",
      overlay: { kind: "help" },
    })
    const detail = help?.handler?.(ctx("settings")) as {
      kind: string
      overlay: { kind: string; title: string; body: string }
    }
    expect(detail.kind).toBe("openOverlay")
    expect(detail.overlay.kind).toBe("document")
    expect(detail.overlay.title).toBe("Help: /settings")
    expect(detail.overlay.body).toContain("# /settings")
    // Unknown target → a helpful notice, not a blank document.
    expect(help?.handler?.(ctx("nope"))).toMatchObject({
      kind: "notice",
      message: expect.stringContaining("Unknown command /nope"),
    })
  })

  it("/settings <field> <value> applies a file-only field instead of opening the panel", () => {
    const settings = getCommand("settings")
    const effect = settings?.handler?.({
      state: {},
      config: {
        provider: "anthropic",
        permissionMode: "default",
        builtinTools: {},
        providers: {},
        cwd: "/w",
      },
      version: "0",
      args: "systemPrompt be concise",
    } as never)
    expect(effect).toEqual({ kind: "settingsSet", field: "systemPrompt", value: "be concise" })
  })

  it("/clear confirms before wiping, and `--yes` performs the reset", () => {
    const clear = getCommand("clear")
    const ctx = (args: string) => ({ state: {}, config: {}, version: "0", args }) as never
    expect(clear?.handler?.(ctx(""))).toMatchObject({
      kind: "openOverlay",
      overlay: { kind: "confirm", onConfirmCommand: "clear --yes" },
    })
    expect(clear?.handler?.(ctx("--yes"))).toEqual({ kind: "clear" })
  })

  it("registers a new command and surfaces it through listCommands + getCommand", () => {
    registerCommand(stub("frobnicate", { aliases: ["frob"] }))
    expect(getCommand("frobnicate")?.name).toBe("frobnicate")
    expect(getCommand("frob")?.name).toBe("frobnicate")
    expect(listCommands().some((c) => c.name === "frobnicate")).toBe(true)
  })

  it("registers many commands at once", () => {
    registerCommands([stub("alpha"), stub("beta")])
    expect(getCommand("alpha")).toBeDefined()
    expect(getCommand("beta")).toBeDefined()
  })

  it("rejects a duplicate name", () => {
    expect(() => registerCommand(stub("model"))).toThrow(/model/)
  })

  it("rejects a name that collides with an existing alias", () => {
    expect(() => registerCommand(stub("new"))).toThrow(/new/)
  })

  it("hides hidden commands from the visible list but keeps them dispatchable", () => {
    registerCommand(stub("secret", { hidden: true }))
    expect(listVisibleCommands().some((c) => c.name === "secret")).toBe(false)
    expect(getCommand("secret")?.name).toBe("secret")
  })

  it("resets back to the core catalog", () => {
    registerCommand(stub("temp"))
    expect(getCommand("temp")).toBeDefined()
    __resetForTesting()
    expect(getCommand("temp")).toBeUndefined()
    expect(listCommands().length).toBe(CORE_COMMANDS.length)
  })
})
