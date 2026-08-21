import { isTypingTarget, resolveIssueShortcut } from "./shortcuts"

const input = { tagName: "INPUT" }
const div = { tagName: "DIV", closest: () => null }

describe("isTypingTarget", () => {
  it("recognises the text controls", () => {
    expect(isTypingTarget({ tagName: "INPUT" })).toBe(true)
    expect(isTypingTarget({ tagName: "TEXTAREA" })).toBe(true)
    expect(isTypingTarget({ tagName: "SELECT" })).toBe(true)
  })

  it("recognises a contenteditable region", () => {
    expect(isTypingTarget({ tagName: "DIV", isContentEditable: true })).toBe(true)
  })

  it("recognises a control nested inside the event target", () => {
    expect(isTypingTarget({ tagName: "DIV", closest: () => ({}) })).toBe(true)
  })

  it("says no for an ordinary element", () => {
    expect(isTypingTarget(div)).toBe(false)
  })

  it("says no for nothing at all", () => {
    expect(isTypingTarget(null)).toBe(false)
    expect(isTypingTarget(undefined)).toBe(false)
  })
})

describe("resolveIssueShortcut", () => {
  it("maps the bare keys", () => {
    expect(resolveIssueShortcut({ key: "c", target: div })).toBe("create")
    expect(resolveIssueShortcut({ key: "/", target: div })).toBe("focusSearch")
    expect(resolveIssueShortcut({ key: "j", target: div })).toBe("next")
    expect(resolveIssueShortcut({ key: "k", target: div })).toBe("previous")
    expect(resolveIssueShortcut({ key: "x", target: div })).toBe("toggleSelect")
    expect(resolveIssueShortcut({ key: "Enter", target: div })).toBe("open")
  })

  it("accepts the arrow keys as aliases for j and k", () => {
    expect(resolveIssueShortcut({ key: "ArrowDown", target: div })).toBe("next")
    expect(resolveIssueShortcut({ key: "ArrowUp", target: div })).toBe("previous")
  })

  it("ignores an unmapped key", () => {
    expect(resolveIssueShortcut({ key: "q", target: div })).toBeNull()
  })

  it("does not claim `e`: Enter already opens the inspector, where editing lives", () => {
    expect(resolveIssueShortcut({ key: "e", target: div })).toBeNull()
  })

  it("never claims a modified keystroke, so Cmd+K stays the command palette", () => {
    expect(resolveIssueShortcut({ key: "k", metaKey: true, target: div })).toBeNull()
    expect(resolveIssueShortcut({ key: "c", ctrlKey: true, target: div })).toBeNull()
    expect(resolveIssueShortcut({ key: "j", altKey: true, target: div })).toBeNull()
  })

  it("ignores a keystroke another handler already claimed", () => {
    expect(resolveIssueShortcut({ key: "c", target: div, defaultPrevented: true })).toBeNull()
  })

  describe("while typing", () => {
    it("does not swallow letters out of the search box", () => {
      expect(resolveIssueShortcut({ key: "c", target: input })).toBeNull()
      expect(resolveIssueShortcut({ key: "x", target: input })).toBeNull()
      expect(resolveIssueShortcut({ key: "/", target: input })).toBeNull()
    })

    it("still lets Escape clear, which is where it is reached for most", () => {
      expect(resolveIssueShortcut({ key: "Escape", target: input })).toBe("clearSelection")
    })
  })

  describe("shift", () => {
    it("passes through for the keys that use it for range selection", () => {
      expect(resolveIssueShortcut({ key: "x", shiftKey: true, target: div })).toBe("toggleSelect")
      expect(resolveIssueShortcut({ key: "j", shiftKey: true, target: div })).toBe("next")
    })

    it("blocks the rest, so Shift+/ is a question mark and not a focus jump", () => {
      expect(resolveIssueShortcut({ key: "/", shiftKey: true, target: div })).toBeNull()
      expect(resolveIssueShortcut({ key: "c", shiftKey: true, target: div })).toBeNull()
    })
  })
})
