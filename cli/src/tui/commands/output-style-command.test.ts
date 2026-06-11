import { outputStyleCommand } from "./output-style-command"
import type { CommandContext } from "./types"
import type { ResolvedConfig } from "../../config/schema"

function ctx(args: string, outputStyle?: ResolvedConfig["outputStyle"]): CommandContext {
  const config = { provider: "anthropic", outputStyle } as unknown as ResolvedConfig
  return { state: {} as never, config, version: "0", args }
}

const run = (args: string, style?: ResolvedConfig["outputStyle"]) =>
  outputStyleCommand.handler!(ctx(args, style))

describe("/output-style", () => {
  it("opens the picker when bare, flagging the current style", () => {
    const eff = run("", "concise")
    expect(eff).toMatchObject({
      kind: "openOverlay",
      overlay: { kind: "select", title: "Output style", onSelectCommand: "output-style" },
    })
    if (eff.kind !== "openOverlay" || eff.overlay.kind !== "select") throw new Error("bad effect")
    expect(eff.overlay.items.find((i) => i.id === "concise")?.hint).toBe("current")
  })

  it("defaults the current style to default when none is set", () => {
    const eff = run("")
    if (eff.kind !== "openOverlay" || eff.overlay.kind !== "select") throw new Error("bad effect")
    expect(eff.overlay.items.find((i) => i.id === "default")?.hint).toBe("current")
  })

  it("sets a known style", () => {
    expect(run("explanatory")).toEqual({ kind: "outputStyle", style: "explanatory" })
    expect(run("LEARNING")).toEqual({ kind: "outputStyle", style: "learning" })
  })

  it("rejects an unknown style", () => {
    const eff = run("verbose")
    expect(eff).toMatchObject({ kind: "notice" })
    if (eff.kind !== "notice") throw new Error("bad effect")
    expect(eff.message).toMatch(/Unknown output style/)
  })
})
