import { APP_SHORTCUT_CATALOG, getDefaultAcceptedChords } from "@/lib/shortcuts/app-catalog"
import {
  INBOX_TRIAGE_SHORTCUTS,
  resolveTriageKey,
  triageMoveIndex,
  type InboxTriageCommand,
  type TriageKeyInput,
} from "./triage-keymap"

describe("resolveTriageKey", () => {
  it.each<[TriageKeyInput, InboxTriageCommand]>([
    [{ key: "j" }, { kind: "move", to: "next", extend: false }],
    [{ key: "ArrowDown" }, { kind: "move", to: "next", extend: false }],
    [{ key: "k" }, { kind: "move", to: "prev", extend: false }],
    [{ key: "ArrowUp" }, { kind: "move", to: "prev", extend: false }],
    [{ key: "Home" }, { kind: "move", to: "first", extend: false }],
    [{ key: "End" }, { kind: "move", to: "last", extend: false }],
    [
      { key: "J", shiftKey: true },
      { kind: "move", to: "next", extend: true },
    ],
    [
      { key: "K", shiftKey: true },
      { kind: "move", to: "prev", extend: true },
    ],
    [
      { key: "ArrowDown", shiftKey: true },
      { kind: "move", to: "next", extend: true },
    ],
    [
      { key: "End", shiftKey: true },
      { kind: "move", to: "last", extend: true },
    ],
    [{ key: "Enter" }, { kind: "open" }],
    [{ key: "o" }, { kind: "open" }],
    [{ key: "x" }, { kind: "toggleCheck" }],
    [{ key: "a", metaKey: true }, { kind: "selectAll" }],
    [{ key: "a", ctrlKey: true }, { kind: "selectAll" }],
    [{ key: "/" }, { kind: "focusSearch" }],
    [{ key: "Escape" }, { kind: "escape" }],
    [{ key: "u" }, { kind: "toggleRead" }],
    [{ key: "p" }, { kind: "togglePin" }],
    [{ key: "e" }, { kind: "toggleArchive" }],
    [{ key: "d" }, { kind: "resolve" }],
    [{ key: "s" }, { kind: "snooze" }],
    [{ key: "i" }, { kind: "assign" }],
    [{ key: "l" }, { kind: "label" }],
    [{ key: "?", shiftKey: true }, { kind: "help" }],
  ])("%j → %j", (input, command) => {
    expect(resolveTriageKey(input)).toEqual(command)
  })

  it.each<TriageKeyInput>([
    { key: "q" },
    { key: "Tab" },
    { key: "e", altKey: true },
    { key: "u", ctrlKey: true },
    { key: "a", ctrlKey: true, shiftKey: true },
    { key: "E", shiftKey: true },
    // A stuck Caps Lock types capitals with no Shift; never a triage write.
    { key: "D" },
    { key: "Enter", shiftKey: true },
    { key: "j", isComposing: true },
    { key: "F5" },
  ])("ignores %j", (input) => {
    expect(resolveTriageKey(input)).toBeNull()
  })
})

describe("triageMoveIndex", () => {
  it("starts at the edge it moves from when nothing is current", () => {
    expect(triageMoveIndex(-1, 4, "next")).toBe(0)
    expect(triageMoveIndex(-1, 4, "prev")).toBe(3)
  })

  it("clamps at both ends", () => {
    expect(triageMoveIndex(3, 4, "next")).toBe(3)
    expect(triageMoveIndex(0, 4, "prev")).toBe(0)
    expect(triageMoveIndex(1, 4, "next")).toBe(2)
    expect(triageMoveIndex(2, 4, "prev")).toBe(1)
  })

  it("jumps to the first and last rows", () => {
    expect(triageMoveIndex(2, 4, "first")).toBe(0)
    expect(triageMoveIndex(0, 4, "last")).toBe(3)
  })

  it("has nowhere to go in an empty list", () => {
    expect(triageMoveIndex(-1, 0, "next")).toBe(-1)
  })
})

describe("INBOX_TRIAGE_SHORTCUTS", () => {
  /** Turn a help-table combo back into the key input it describes. */
  function inputFor(combo: readonly string[]): TriageKeyInput {
    const named: Record<string, string> = {
      enter: "Enter",
      escape: "Escape",
      up: "ArrowUp",
      down: "ArrowDown",
      home: "Home",
      end: "End",
    }
    const shift = combo.includes("shift")
    const mod = combo.includes("mod")
    const key = combo.find((token) => token !== "shift" && token !== "mod")!
    const literal = named[key] ?? key
    return {
      key: shift && literal.length === 1 ? literal.toUpperCase() : literal,
      shiftKey: shift || key === "?",
      metaKey: mod,
    }
  }

  it("only advertises keys the resolver honours", () => {
    for (const entry of INBOX_TRIAGE_SHORTCUTS) {
      for (const combo of entry.keys) {
        expect(resolveTriageKey(inputFor(combo))).not.toBeNull()
      }
    }
  })

  it("lists every command the resolver can produce", () => {
    const listed = new Set(INBOX_TRIAGE_SHORTCUTS.map((entry) => entry.id))
    for (const kind of [
      "open",
      "toggleCheck",
      "selectAll",
      "focusSearch",
      "escape",
      "toggleRead",
      "togglePin",
      "toggleArchive",
      "resolve",
      "snooze",
      "assign",
      "label",
      "help",
    ]) {
      expect(listed.has(kind as never)).toBe(true)
    }
    expect(listed.has("next")).toBe(true)
    expect(listed.has("extend")).toBe(true)
  })

  it("documents every app-catalog chord it shares, and they are all mount-scoped", () => {
    // The bare letters and arrows the list claims. A new GLOBAL catalog chord
    // on any of them would fire app-wide and fight the list.
    const listKeys = new Set(["j", "k", "x", "u", "p", "e", "d", "s", "i", "l", "o", "?", "/"])
    const shared = APP_SHORTCUT_CATALOG.filter((descriptor) =>
      getDefaultAcceptedChords(descriptor.id).some((chord) => listKeys.has(chord))
    ).map((descriptor) => descriptor.id)
    expect(shared.sort()).toEqual(
      [
        "app.search.focus",
        "observability.openSettings",
        "observability.toggleEdit",
        "skills.search",
      ].sort()
    )
  })
})
