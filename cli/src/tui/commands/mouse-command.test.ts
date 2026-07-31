import { mouseCommand } from "./mouse-command"
import type { CommandContext } from "./types"
import type { ResolvedConfig } from "../../config/schema"

function ctx(args: string, mouse?: ResolvedConfig["mouse"]): CommandContext {
  const config = { provider: "anthropic", mouse } as unknown as ResolvedConfig
  return { state: {} as never, config, version: "0", args }
}

const run = (args: string, mouse?: ResolvedConfig["mouse"]) =>
  mouseCommand.handler!(ctx(args, mouse))

describe("/mouse", () => {
  it("opens the picker when bare, flagging the current mode", () => {
    const eff = run("", "scroll")
    expect(eff).toMatchObject({
      kind: "openOverlay",
      overlay: { kind: "select", title: "Mouse mode", onSelectCommand: "mouse" },
    })
    if (eff.kind !== "openOverlay" || eff.overlay.kind !== "select") throw new Error("bad effect")
    expect(eff.overlay.items.find((i) => i.id === "scroll")?.hint).toMatch(/current/)
    expect(eff.overlay.index).toBe(eff.overlay.items.findIndex((i) => i.id === "scroll"))
  })

  it("defaults the current mode to scroll when unset", () => {
    const eff = run("")
    if (eff.kind !== "openOverlay" || eff.overlay.kind !== "select") throw new Error("bad effect")
    expect(eff.overlay.items.find((i) => i.id === "scroll")?.hint).toMatch(/current/)
  })

  it("sets a known mode (case-insensitive)", () => {
    expect(run("select")).toEqual({ kind: "mouse", mode: "select" })
    expect(run("SCROLL")).toEqual({ kind: "mouse", mode: "scroll" })
  })

  it("rejects an unknown mode", () => {
    const eff = run("trackpad")
    expect(eff).toMatchObject({ kind: "notice" })
    if (eff.kind !== "notice") throw new Error("bad effect")
    expect(eff.message).toMatch(/Unknown mouse mode/)
  })

  it("advertises a useful argument hint", () => {
    expect(mouseCommand.argumentHint).toContain("select")
    expect(mouseCommand.category).toBe("config")
  })
})
