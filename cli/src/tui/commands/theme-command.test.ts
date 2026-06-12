import { themeCommand } from "./theme-command"
import type { CommandContext } from "./types"
import type { ResolvedConfig } from "../../config/schema"

function ctx(args: string, theme?: string): CommandContext {
  const config = { provider: "anthropic", theme } as unknown as ResolvedConfig
  return { state: {} as never, config, version: "0", args }
}

const run = (args: string, theme?: string) => themeCommand.handler!(ctx(args, theme))

describe("/theme", () => {
  it("opens the theme picker when bare, flagging the current theme", () => {
    const eff = run("", "dark")
    expect(eff).toMatchObject({
      kind: "openOverlay",
      overlay: { kind: "select", title: "Colour theme", onSelectCommand: "theme set" },
    })
    if (eff.kind !== "openOverlay" || eff.overlay.kind !== "select") throw new Error("bad effect")
    expect(eff.overlay.items.find((i) => i.id === "dark")?.hint).toBe("current")
    // the reuse pseudo-themes are offered
    expect(eff.overlay.items.find((i) => i.id === "claude-code")).toBeTruthy()
    expect(eff.overlay.items.find((i) => i.id === "codex")).toBeTruthy()
  })

  it("defaults the current theme to classic when none is set", () => {
    const eff = run("")
    if (eff.kind !== "openOverlay" || eff.overlay.kind !== "select") throw new Error("bad effect")
    expect(eff.overlay.items.find((i) => i.id === "classic")?.hint).toBe("current")
  })

  it("sets a built-in theme directly", () => {
    expect(run("dark")).toEqual({ kind: "theme", theme: "dark" })
  })

  it("sets a theme via the explicit set verb", () => {
    expect(run("set light")).toEqual({ kind: "theme", theme: "light" })
  })

  it("accepts the reuse pseudo-themes and custom slugs", () => {
    expect(run("claude-code")).toEqual({ kind: "theme", theme: "claude-code" })
    expect(run("codex")).toEqual({ kind: "theme", theme: "codex" })
    expect(run("set custom:neon")).toEqual({ kind: "theme", theme: "custom:neon" })
  })

  it("rejects an unknown theme", () => {
    const eff = run("rainbow")
    expect(eff).toMatchObject({ kind: "notice" })
    if (eff.kind !== "notice") throw new Error("bad effect")
    expect(eff.message).toMatch(/Unknown theme/)
  })
})
