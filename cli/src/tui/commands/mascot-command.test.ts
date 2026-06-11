import { mascotCommand } from "./mascot-command"
import type { CommandContext } from "./types"
import type { ResolvedConfig } from "../../config/schema"

function ctx(args: string, mascot?: ResolvedConfig["mascot"]): CommandContext {
  const config = { provider: "anthropic", mascot } as unknown as ResolvedConfig
  return { state: {} as never, config, version: "0", args }
}

const run = (args: string, mascot?: ResolvedConfig["mascot"]) =>
  mascotCommand.handler!(ctx(args, mascot))

describe("/mascot", () => {
  it("opens the style picker when bare, flagging the current style", () => {
    const eff = run("", { style: "cat" })
    expect(eff).toMatchObject({
      kind: "openOverlay",
      overlay: { kind: "select", title: "Mascot style", onSelectCommand: "mascot style" },
    })
    if (eff.kind !== "openOverlay" || eff.overlay.kind !== "select") throw new Error("bad effect")
    const cat = eff.overlay.items.find((i) => i.id === "cat")
    expect(cat?.hint).toBe("current")
  })

  it("defaults the current style to clawd when none is set", () => {
    const eff = run("")
    if (eff.kind !== "openOverlay" || eff.overlay.kind !== "select") throw new Error("bad effect")
    expect(eff.overlay.items.find((i) => i.id === "clawd")?.hint).toBe("current")
  })

  it("turns the mascot on / off", () => {
    expect(run("on")).toEqual({ kind: "mascot", patch: { enabled: true } })
    expect(run("off")).toEqual({ kind: "mascot", patch: { enabled: false } })
  })

  it("sets a known style and re-enables", () => {
    expect(run("style robot")).toEqual({
      kind: "mascot",
      patch: { style: "robot", enabled: true },
    })
  })

  it("rejects an unknown style", () => {
    const eff = run("style dragon")
    expect(eff).toMatchObject({ kind: "notice" })
    if (eff.kind !== "notice") throw new Error("bad effect")
    expect(eff.message).toMatch(/Unknown mascot style/)
  })

  it("shows usage for an unknown verb", () => {
    const eff = run("wat")
    expect(eff).toMatchObject({ kind: "notice" })
    if (eff.kind !== "notice") throw new Error("bad effect")
    expect(eff.message).toMatch(/Usage: \/mascot/)
  })
})
