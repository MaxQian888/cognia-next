/**
 * @jest-environment node
 */
import {
  DEFAULT_KEYBINDINGS,
  KEYBINDABLE_ACTIONS,
  findKeybindingConflicts,
  formatKeySpec,
  matchAction,
  matchKeySpec,
  parseKeySpec,
  resolveKeybindings,
} from "./keybindings"
import type { KeyFlags } from "./keymap"

const ctrl = (input: string): [string, KeyFlags] => [input, { ctrl: true }]

describe("parseKeySpec", () => {
  it("parses a ctrl chord", () => {
    expect(parseKeySpec("ctrl+o")).toEqual({ ctrl: true, shift: false, meta: false, key: "o" })
  })
  it("is case-insensitive and trims", () => {
    expect(parseKeySpec(" Ctrl + G ")).toEqual({ ctrl: true, shift: false, meta: false, key: "g" })
  })
  it("treats alt/option/cmd as meta", () => {
    expect(parseKeySpec("alt+x")?.meta).toBe(true)
    expect(parseKeySpec("cmd+x")?.meta).toBe(true)
  })
  it("rejects an empty or modifier-only spec", () => {
    expect(parseKeySpec("")).toBeNull()
    expect(parseKeySpec("ctrl")).toBeNull()
  })
  it("rejects a multi-character base key", () => {
    expect(parseKeySpec("ctrl+tab")).toBeNull()
  })
})

describe("formatKeySpec", () => {
  it("renders a canonical display form", () => {
    expect(formatKeySpec("ctrl+o")).toBe("Ctrl+O")
    expect(formatKeySpec("ctrl+shift+x")).toBe("Ctrl+Shift+X")
  })
  it("returns a dash for an invalid spec", () => {
    expect(formatKeySpec("bogus+")).toBe("—")
  })
})

describe("matchKeySpec", () => {
  it("matches a ctrl chord against an Ink key event", () => {
    expect(matchKeySpec("ctrl+o", ...ctrl("o"))).toBe(true)
  })
  it("does not match the wrong letter or missing modifier", () => {
    expect(matchKeySpec("ctrl+o", ...ctrl("p"))).toBe(false)
    expect(matchKeySpec("ctrl+o", "o", {})).toBe(false)
  })
  it("requires shift/meta to match exactly", () => {
    expect(matchKeySpec("ctrl+o", "o", { ctrl: true, shift: true })).toBe(false)
  })
})

describe("resolveKeybindings", () => {
  it("returns the defaults when no overrides", () => {
    expect(resolveKeybindings(undefined)).toEqual(DEFAULT_KEYBINDINGS)
  })
  it("overlays valid overrides and ignores invalid ones", () => {
    const r = resolveKeybindings({ inspect: "ctrl+j", verboseToggle: "nonsense+" })
    expect(r.inspect).toBe("ctrl+j")
    // Invalid spec is ignored → default kept.
    expect(r.verboseToggle).toBe(DEFAULT_KEYBINDINGS.verboseToggle)
  })
  it("ignores unknown action ids in overrides", () => {
    const r = resolveKeybindings({ notAnAction: "ctrl+z" } as Record<string, string>)
    expect(r).toEqual(DEFAULT_KEYBINDINGS)
  })
})

describe("matchAction", () => {
  it("maps default chords back to their actions", () => {
    const b = resolveKeybindings(undefined)
    expect(matchAction(b, ...ctrl("g"))).toBe("inspect")
    expect(matchAction(b, ...ctrl("o"))).toBe("verboseToggle")
    expect(matchAction(b, ...ctrl("t"))).toBe("collapseAll")
    expect(matchAction(b, ...ctrl("a"))).toBe("lineHome")
    expect(matchAction(b, ...ctrl("u"))).toBe("lineKillToStart")
    expect(matchAction(b, ...ctrl("k"))).toBe("lineKillToEnd")
  })
  it("returns undefined for an unbound key", () => {
    expect(matchAction(resolveKeybindings(undefined), ...ctrl("p"))).toBeUndefined()
  })
  it("maps the undo/redo chords back to their actions", () => {
    const b = resolveKeybindings(undefined)
    expect(matchAction(b, ...ctrl("z"))).toBe("undo")
    expect(matchAction(b, ...ctrl("y"))).toBe("redo")
  })
  it("honours a user override", () => {
    const b = resolveKeybindings({ inspect: "ctrl+j" })
    expect(matchAction(b, ...ctrl("j"))).toBe("inspect")
    expect(matchAction(b, ...ctrl("g"))).toBeUndefined()
  })
})

describe("findKeybindingConflicts", () => {
  it("reports two actions bound to the same key", () => {
    const b = resolveKeybindings({ inspect: "ctrl+o" }) // collides with verboseToggle
    const conflicts = findKeybindingConflicts(b)
    expect(conflicts["Ctrl+O"]).toEqual(expect.arrayContaining(["inspect", "verboseToggle"]))
  })
  it("finds no conflicts in the defaults", () => {
    expect(findKeybindingConflicts(DEFAULT_KEYBINDINGS)).toEqual({})
  })
})

describe("DEFAULT_KEYBINDINGS", () => {
  it("has a binding for every keybindable action", () => {
    for (const action of KEYBINDABLE_ACTIONS) {
      expect(parseKeySpec(DEFAULT_KEYBINDINGS[action])).not.toBeNull()
    }
  })
})
