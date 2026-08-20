import { FIXTURE_PING_COMMAND, ping, provideFixtureLenses } from "./index"

describe("provideFixtureLenses", () => {
  it("always returns exactly one lens", () => {
    // A fixture that produced lenses conditionally would make a broken
    // round-trip and an empty result look identical — and "no lens appeared" is
    // the failure this whole plugin exists to catch.
    expect(provideFixtureLenses({ path: "/repo/a.ts", lineCount: 10 })).toHaveLength(1)
    expect(provideFixtureLenses({ path: "/repo/empty.ts", lineCount: 0 })).toHaveLength(1)
  })

  it("anchors to the first line so the lens is always in view", () => {
    const [lens] = provideFixtureLenses({ path: "/repo/a.ts", lineCount: 10 })
    expect(lens!.range).toEqual({ startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 })
  })

  it("echoes the request back in the title, making the round-trip visible", () => {
    const [lens] = provideFixtureLenses({ path: "/repo/lib/deep/file.ts", lineCount: 42 })
    expect(lens!.command.title).toBe("Cognia fixture: file.ts (42 lines)")
  })

  it("handles a Windows path", () => {
    const [lens] = provideFixtureLenses({ path: "C:\\work\\proj\\a.ts", lineCount: 3 })
    expect(lens!.command.title).toContain("a.ts")
  })

  it("falls back to the whole path when it has no separator", () => {
    const [lens] = provideFixtureLenses({ path: "scratch.ts", lineCount: 1 })
    expect(lens!.command.title).toContain("scratch.ts")
  })

  it("points the lens at the plugin's own contributed command", () => {
    // The click path is the second half of the proof: the editor calls back
    // into a command this plugin's manifest contributed.
    const [lens] = provideFixtureLenses({ path: "/repo/a.ts", lineCount: 1 })
    // The namespaced form the compiler emits — a lens pointing at the
    // plugin-local name renders and then does nothing when clicked.
    expect(lens!.command.command).toBe(FIXTURE_PING_COMMAND)
    expect(FIXTURE_PING_COMMAND).toBe("cognia.cognia-pro-ide-fixture.ping")
    expect(lens!.command.arguments).toEqual([{ path: "/repo/a.ts" }])
  })
})

describe("ping", () => {
  it("returns what the lens click carried", () => {
    expect(ping({ path: "/repo/a.ts" })).toEqual({ ok: true, path: "/repo/a.ts" })
  })

  it("survives an invocation from the command palette, which carries nothing", () => {
    expect(ping()).toEqual({ ok: true, path: null })
  })
})
