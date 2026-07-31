import { layoutCommand } from "./layout-command"
import type { CommandContext } from "./types"
import type { ResolvedConfig } from "../../config/schema"

function ctx(args: string, layout?: ResolvedConfig["layout"]): CommandContext {
  const config = { provider: "anthropic", layout } as unknown as ResolvedConfig
  return { state: {} as never, config, version: "0", args }
}

const run = (args: string, layout?: ResolvedConfig["layout"]) =>
  layoutCommand.handler!(ctx(args, layout))

describe("/layout", () => {
  it("opens the picker when bare, flagging the current mode", () => {
    const eff = run("", "scrollback")
    expect(eff).toMatchObject({
      kind: "openOverlay",
      overlay: { kind: "select", title: "Layout", onSelectCommand: "layout" },
    })
    if (eff.kind !== "openOverlay" || eff.overlay.kind !== "select") throw new Error("bad effect")
    const sb = eff.overlay.items.find((i) => i.id === "scrollback")
    expect(sb?.hint).toMatch(/current/)
    // The picker opens pre-selected on the current mode.
    expect(eff.overlay.index).toBe(eff.overlay.items.findIndex((i) => i.id === "scrollback"))
  })

  it("defaults the current mode to fullscreen when unset", () => {
    const eff = run("")
    if (eff.kind !== "openOverlay" || eff.overlay.kind !== "select") throw new Error("bad effect")
    expect(eff.overlay.items.find((i) => i.id === "fullscreen")?.hint).toMatch(/current/)
  })

  it("sets a known mode (case-insensitive)", () => {
    expect(run("fullscreen")).toEqual({ kind: "layout", mode: "fullscreen" })
    expect(run("SCROLLBACK")).toEqual({ kind: "layout", mode: "scrollback" })
  })

  it("rejects an unknown mode", () => {
    const eff = run("windowed")
    expect(eff).toMatchObject({ kind: "notice" })
    if (eff.kind !== "notice") throw new Error("bad effect")
    expect(eff.message).toMatch(/Unknown layout/)
  })

  it("advertises a useful argument hint", () => {
    expect(layoutCommand.argumentHint).toContain("fullscreen")
    expect(layoutCommand.category).toBe("config")
  })
})
