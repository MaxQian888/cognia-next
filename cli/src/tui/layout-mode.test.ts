import { DEFAULT_LAYOUT, readLayoutCapability, resolveLayoutMode } from "./layout-mode"

const tty = { stdoutIsTTY: true, stdinIsTTY: true, term: "xterm-256color" }

describe("resolveLayoutMode", () => {
  it("defaults to fullscreen on an interactive TTY", () => {
    expect(resolveLayoutMode(undefined, tty)).toBe("fullscreen")
    expect(DEFAULT_LAYOUT).toBe("fullscreen")
  })

  it("honors an explicit fullscreen preference on a TTY", () => {
    expect(resolveLayoutMode("fullscreen", tty)).toBe("fullscreen")
  })

  it("honors an explicit scrollback preference even on a TTY", () => {
    expect(resolveLayoutMode("scrollback", tty)).toBe("scrollback")
  })

  it("falls back to scrollback when stdout is not a TTY", () => {
    expect(resolveLayoutMode("fullscreen", { ...tty, stdoutIsTTY: false })).toBe("scrollback")
  })

  it("falls back to scrollback when stdin is not a TTY", () => {
    expect(resolveLayoutMode("fullscreen", { ...tty, stdinIsTTY: false })).toBe("scrollback")
  })

  it("falls back to scrollback on a dumb terminal (case-insensitive)", () => {
    expect(resolveLayoutMode("fullscreen", { ...tty, term: "dumb" })).toBe("scrollback")
    expect(resolveLayoutMode("fullscreen", { ...tty, term: "DUMB" })).toBe("scrollback")
  })

  it("treats a missing TERM as non-dumb", () => {
    expect(resolveLayoutMode("fullscreen", { stdoutIsTTY: true, stdinIsTTY: true })).toBe(
      "fullscreen"
    )
  })
})

describe("readLayoutCapability", () => {
  it("reads TTY flags + TERM from the process", () => {
    const cap = readLayoutCapability({
      stdout: { isTTY: true },
      stdin: { isTTY: false },
      env: { TERM: "screen" },
    })
    expect(cap).toEqual({ stdoutIsTTY: true, stdinIsTTY: false, term: "screen" })
  })

  it("coerces undefined TTY flags to false", () => {
    const cap = readLayoutCapability({ stdout: {}, stdin: {}, env: {} })
    expect(cap).toEqual({ stdoutIsTTY: false, stdinIsTTY: false, term: undefined })
  })
})
