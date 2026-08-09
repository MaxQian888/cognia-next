/**
 * @jest-environment node
 */
import { DEFAULT_RESOLVED_CONFIG, type ResolvedConfig } from "../../config/schema"
import { createInitialState } from "../state/initial"
import { statusbarCommand } from "./statusbar-command"
import type { CommandContext } from "./types"

const config: ResolvedConfig = { ...DEFAULT_RESOLVED_CONFIG, cwd: "/work" }

function ctx(args: string, cfg: ResolvedConfig = config): CommandContext {
  return { state: createInitialState(cfg, "s1"), config: cfg, version: "1.0.0", args }
}

const run = (args: string, cfg?: ResolvedConfig) => statusbarCommand.handler!(ctx(args, cfg))

describe("/statusbar", () => {
  it("opens the full customization picker when bare", () => {
    const eff = run("")
    expect(eff.kind).toBe("openOverlay")
    if (eff.kind !== "openOverlay" || eff.overlay.kind !== "select") throw new Error("bad effect")
    expect(eff.overlay.title).toContain("Customize")
    expect(eff.overlay.onSelectCommand).toBe("statusbar")
    expect(eff.overlay.items.map((i) => i.id)).toEqual(
      expect.arrayContaining(["preset minimal", "theme vivid", "toggle git", "hints off", "reset"])
    )
  })

  it("marks the current theme in the picker", () => {
    const cfg = { ...config, statusBar: { theme: "dim" as const } }
    const eff = run("", cfg)
    if (eff.kind !== "openOverlay" || eff.overlay.kind !== "select") throw new Error("bad effect")
    expect(eff.overlay.items.find((i) => i.id === "theme dim")?.hint).toBe("current")
  })

  it("sets a valid theme", () => {
    expect(run("theme vivid")).toEqual({ kind: "statusBar", patch: { theme: "vivid" } })
  })

  it("rejects an unknown theme", () => {
    const eff = run("theme neon")
    expect(eff.kind).toBe("notice")
    if (eff.kind === "notice") expect(eff.message).toContain("Unknown theme")
  })

  it("sets a valid segment list", () => {
    expect(run("segments model,mode,ctx")).toEqual({
      kind: "statusBar",
      patch: { segments: ["model", "mode", "ctx"] },
    })
  })

  it("rejects an unknown segment", () => {
    const eff = run("segments model,bogus")
    expect(eff.kind).toBe("notice")
    if (eff.kind === "notice") expect(eff.message).toContain("Segments:")
  })

  it("rejects an empty segment list", () => {
    expect(run("segments").kind).toBe("notice")
  })

  it("toggles individual segments and exposes presets", () => {
    expect(run("toggle git")).toMatchObject({ kind: "statusBar" })
    expect(run("preset minimal")).toEqual({
      kind: "statusBar",
      patch: { segments: ["model", "mode", "ctx"] },
    })
    expect(run("preset unknown").kind).toBe("notice")
  })

  it("toggles idle command hints", () => {
    expect(run("hints off")).toEqual({ kind: "statusBar", patch: { showHints: false } })
    expect(run("hints maybe").kind).toBe("notice")
  })

  it("resets to the default layout + theme", () => {
    const eff = run("reset")
    expect(eff).toMatchObject({ kind: "statusBar", patch: { theme: "default" } })
    if (eff.kind === "statusBar") expect(eff.patch.segments).toContain("model")
  })

  it("notices on an unknown verb", () => {
    expect(run("frobnicate").kind).toBe("notice")
  })
})
