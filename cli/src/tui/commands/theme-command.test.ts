import { themeCommand } from "./theme-command"
import type { CommandArgSpec, CommandContext } from "./types"
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

  it("opens the colour editor form on bare `custom`, seeded from a built-in", () => {
    const eff = run("custom", "dark")
    expect(eff.kind).toBe("openForm")
    if (eff.kind !== "openForm") throw new Error("bad effect")
    expect(eff.form).toMatchObject({ commandName: "theme", subcommand: "custom" })
    const names = eff.form.specs.map((s: CommandArgSpec) => s.name)
    // The 8 base roles come first, then the per-token override fields.
    expect(names.slice(0, 8)).toEqual([
      "accent",
      "secondary",
      "info",
      "success",
      "warning",
      "danger",
      "muted",
      "text",
    ])
    expect(names).toContain("codeKeyword")
    expect(names).toContain("diffAdded")
    // text is optional; the rest are required and pre-seeded from the `dark` palette
    expect(eff.form.specs.find((s: CommandArgSpec) => s.name === "text")!.required).toBe(false)
    expect(eff.form.specs.find((s: CommandArgSpec) => s.name === "accent")!.default).toBeTruthy()
    // Override fields are optional.
    expect(eff.form.specs.find((s: CommandArgSpec) => s.name === "codeKeyword")!.required).toBe(
      false
    )
  })

  it("emits a customTheme effect from submitted colour flags", () => {
    const eff = run("custom --accent #112233 --muted gray --bogus x")
    expect(eff.kind).toBe("customTheme")
    if (eff.kind !== "customTheme") throw new Error("bad effect")
    expect(eff.base.accent).toBe("#112233")
    expect(eff.base.muted).toBe("gray")
    expect(eff.base.bogus).toBeUndefined()
  })

  it("routes per-token flags into overrides, base roles into base", () => {
    const eff = run("custom --accent #112233 --codeKeyword #445566 --diffAdded green")
    expect(eff.kind).toBe("customTheme")
    if (eff.kind !== "customTheme") throw new Error("bad effect")
    expect(eff.base).toEqual({ accent: "#112233" })
    expect(eff.overrides).toEqual({ codeKeyword: "#445566", diffAdded: "green" })
  })

  it("omits overrides when only base colours are given", () => {
    const eff = run("custom --accent #112233")
    if (eff.kind !== "customTheme") throw new Error("bad effect")
    expect(eff.overrides).toBeUndefined()
  })

  it("notices when custom flags carry no valid colours", () => {
    const eff = run("custom --accent not-a-color")
    expect(eff).toMatchObject({ kind: "notice" })
  })
})
