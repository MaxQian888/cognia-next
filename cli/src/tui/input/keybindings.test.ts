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
  parseKeySequence,
  parseKeySpec,
  resolveChordEvent,
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
    expect(matchAction(b, ...ctrl("b"))).toBe("agentsPanel")
    expect(matchAction(b, ...ctrl("o"))).toBe("verboseToggle")
    expect(matchAction(b, ...ctrl("t"))).toBe("collapseAll")
    expect(matchAction(b, ...ctrl("a"))).toBe("lineHome")
    expect(matchAction(b, ...ctrl("u"))).toBe("lineKillToStart")
    expect(matchAction(b, ...ctrl("k"))).toBe("lineKillToEnd")
  })
  it("returns undefined for an unbound key", () => {
    expect(matchAction(resolveKeybindings(undefined), ...ctrl("x"))).toBeUndefined()
  })
  it("maps the undo/redo chords back to their actions", () => {
    const b = resolveKeybindings(undefined)
    expect(matchAction(b, ...ctrl("z"))).toBe("undo")
    expect(matchAction(b, ...ctrl("y"))).toBe("redo")
  })
  it("maps the copy/clear chords back to their actions", () => {
    const b = resolveKeybindings(undefined)
    expect(matchAction(b, ...ctrl("p"))).toBe("copyLast")
    expect(matchAction(b, ...ctrl("l"))).toBe("clearScreen")
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

describe("parseKeySequence", () => {
  it("parses a single chord and a two-step leader sequence", () => {
    expect(parseKeySequence("ctrl+o")).toHaveLength(1)
    const seq = parseKeySequence("ctrl+x n")
    expect(seq).toHaveLength(2)
    expect(seq?.[0]).toMatchObject({ ctrl: true, key: "x" })
    expect(seq?.[1]).toMatchObject({ ctrl: false, key: "n" })
  })

  it("rejects empty, three-step, and malformed sequences", () => {
    expect(parseKeySequence("")).toBeNull()
    expect(parseKeySequence("ctrl+x n m")).toBeNull()
    expect(parseKeySequence("ctrl+x nn")).toBeNull()
  })

  it("formats a sequence for display", () => {
    expect(formatKeySpec("ctrl+x n")).toBe("Ctrl+X N")
  })
})

describe("resolveChordEvent (leader chords)", () => {
  const b = resolveKeybindings({ agentsPanel: "ctrl+x a" })

  it("matches single-step bindings directly", () => {
    expect(resolveChordEvent(b, "g", { ctrl: true }, null)).toEqual({
      kind: "action",
      action: "inspect",
    })
  })

  it("arms the prefix on the leader key and completes on the second", () => {
    const first = resolveChordEvent(b, "x", { ctrl: true }, null)
    expect(first).toEqual({ kind: "prefix", prefix: "Ctrl+X" })
    if (first.kind !== "prefix") throw new Error("expected prefix")
    expect(resolveChordEvent(b, "a", {}, first.prefix)).toEqual({
      kind: "action",
      action: "agentsPanel",
    })
  })

  it("a non-matching second key resolves to none (key flows on normally)", () => {
    expect(resolveChordEvent(b, "q", {}, "Ctrl+X")).toEqual({ kind: "none" })
  })

  it("resolveKeybindings accepts a leader-sequence override", () => {
    expect(b.agentsPanel).toBe("ctrl+x a")
    // Ctrl+B no longer triggers the panel once rebound to the sequence.
    expect(resolveChordEvent(b, "b", { ctrl: true }, null)).toEqual({ kind: "none" })
  })
})
