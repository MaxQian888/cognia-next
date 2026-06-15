/**
 * @jest-environment node
 */
import { keybindHandler, KEYBIND_COMMANDS } from "./keybind-command"
import type { CommandContext } from "./types"

function ctx(args: string, keybindings?: Record<string, string>): CommandContext {
  return {
    args,
    state: { cells: [] },
    config: { keybindings },
    version: "0",
  } as unknown as CommandContext
}

describe("keybindHandler", () => {
  it("opens the action picker with no args", () => {
    const effect = keybindHandler(ctx(""))
    expect(effect.kind).toBe("openOverlay")
    if (effect.kind === "openOverlay" && effect.overlay.kind === "select") {
      expect(effect.overlay.onSelectCommand).toBe("keybind")
      expect(effect.overlay.items.find((i) => i.id === "inspect")?.hint).toBe("Ctrl+G")
    } else {
      throw new Error("expected select overlay")
    }
  })

  it("shows the current binding + instructions for a bare action", () => {
    const effect = keybindHandler(ctx("inspect"))
    expect(effect.kind).toBe("notice")
    if (effect.kind === "notice") {
      expect(effect.message).toContain("Ctrl+G")
      expect(effect.message).toContain("/keybind inspect")
    }
  })

  it("rebinds an action to a valid spec", () => {
    expect(keybindHandler(ctx("inspect ctrl+j"))).toEqual({
      kind: "keybind",
      action: "inspect",
      spec: "ctrl+j",
    })
  })

  it("resets an action with `default`/`reset` (empty spec)", () => {
    expect(keybindHandler(ctx("inspect default"))).toEqual({
      kind: "keybind",
      action: "inspect",
      spec: "",
    })
    expect(keybindHandler(ctx("inspect reset"))).toEqual({
      kind: "keybind",
      action: "inspect",
      spec: "",
    })
  })

  it("rejects an unknown action", () => {
    const effect = keybindHandler(ctx("bogus ctrl+j"))
    expect(effect.kind).toBe("notice")
    if (effect.kind === "notice") expect(effect.message).toContain("Unknown action")
  })

  it("rejects an invalid key spec", () => {
    const effect = keybindHandler(ctx("inspect not-a-key"))
    expect(effect.kind).toBe("notice")
    if (effect.kind === "notice") expect(effect.message).toContain("Invalid key")
  })

  it("reflects a current override in the picker hint", () => {
    const effect = keybindHandler(ctx("", { inspect: "ctrl+j" }))
    if (effect.kind === "openOverlay" && effect.overlay.kind === "select") {
      expect(effect.overlay.items.find((i) => i.id === "inspect")?.hint).toBe("Ctrl+J")
    } else {
      throw new Error("expected select overlay")
    }
  })
})

describe("KEYBIND_COMMANDS", () => {
  it("registers /keybind", () => {
    expect(KEYBIND_COMMANDS[0].name).toBe("keybind")
  })
})
