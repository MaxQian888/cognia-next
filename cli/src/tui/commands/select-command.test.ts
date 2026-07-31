import { selectCommand } from "./select-command"
import { DEFAULT_RESOLVED_CONFIG, type ResolvedConfig } from "../../config/schema"
import type { CommandContext } from "./types"

function ctx(args: string, over: Partial<ResolvedConfig> = {}): CommandContext {
  const config: ResolvedConfig = {
    ...DEFAULT_RESOLVED_CONFIG,
    cwd: "/work",
    mouse: "scroll",
    ...over,
  }
  return { state: { config } as never, config, version: "0.0.0", args }
}

describe("/select", () => {
  it("opens the picker when invoked bare", () => {
    const effect = selectCommand.handler!(ctx(""))
    expect(effect).toMatchObject({
      kind: "openOverlay",
      overlay: { kind: "select", title: "Text selection", onSelectCommand: "select" },
    })
  })

  it("lists every mode and highlights the current one", () => {
    const effect = selectCommand.handler!(ctx("", { selection: "manual" }))
    if (effect.kind !== "openOverlay" || effect.overlay.kind !== "select") throw new Error("picker")
    expect(effect.overlay.items.map((i) => i.id)).toEqual(["off", "manual", "auto-copy"])
    expect(effect.overlay.index).toBe(1)
    expect(effect.overlay.items[1].hint).toMatch(/^current — /)
  })

  it("defaults the picker cursor to off when nothing is configured", () => {
    const effect = selectCommand.handler!(ctx(""))
    if (effect.kind !== "openOverlay" || effect.overlay.kind !== "select") throw new Error("picker")
    expect(effect.overlay.index).toBe(0)
  })

  it("returns a selection effect for each valid mode", () => {
    expect(selectCommand.handler!(ctx("manual"))).toEqual({ kind: "selection", mode: "manual" })
    expect(selectCommand.handler!(ctx("auto-copy"))).toEqual({
      kind: "selection",
      mode: "auto-copy",
    })
    expect(selectCommand.handler!(ctx("  AUTO-COPY  "))).toEqual({
      kind: "selection",
      mode: "auto-copy",
    })
  })

  it("rejects an unknown mode with the valid choices", () => {
    expect(selectCommand.handler!(ctx("sometimes"))).toEqual({
      kind: "notice",
      message: 'Unknown selection mode "sometimes" — choose: off, manual, auto-copy',
    })
  })

  it("refuses to enable selection under the `select` mouse model", () => {
    const effect = selectCommand.handler!(ctx("auto-copy", { mouse: "select" }))
    expect(effect).toEqual({
      kind: "notice",
      message:
        "In-app selection needs the `scroll` mouse model (it reads the mouse). Run /mouse scroll first.",
    })
  })

  it("still allows turning selection OFF under the `select` mouse model", () => {
    expect(selectCommand.handler!(ctx("off", { mouse: "select" }))).toEqual({
      kind: "selection",
      mode: "off",
    })
  })
})
