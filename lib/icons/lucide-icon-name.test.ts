import { icons as lucideIcons } from "lucide-react"

import { isLegacyKebabIconName, toLucideIconName } from "./lucide-icon-name"

const isKnown = (name: string) => Object.prototype.hasOwnProperty.call(lucideIcons, name)

describe("toLucideIconName", () => {
  it.each([
    ["file-text", "FileText"],
    ["panel-right", "PanelRight"],
    ["message-square", "MessageSquare"],
    ["search-code", "SearchCode"],
    ["bot", "Bot"],
    ["volume-2", "Volume2"],
  ])("maps the legacy %s spelling to %s", (legacy, expected) => {
    expect(toLucideIconName(legacy)).toBe(expected)
  })

  it("resolves every icon the retired context-panel allowlist published", () => {
    // The exact constant `types/plugin/plugin-context-panel.ts` exported before
    // it was replaced by a raw `lucide-react` lookup. A plugin pinned to any of
    // these must keep installing.
    const retiredAllowlist = [
      "blocks",
      "bot",
      "file-text",
      "history",
      "info",
      "message-square",
      "panel-right",
      "play",
      "search-code",
      "settings",
      "wrench",
    ]
    for (const legacy of retiredAllowlist) {
      expect(isKnown(toLucideIconName(legacy))).toBe(true)
    }
  })

  it("leaves an already-exported PascalCase name alone", () => {
    expect(toLucideIconName("FileText")).toBe("FileText")
    expect(toLucideIconName("PanelsTopLeft")).toBe("PanelsTopLeft")
  })

  it("returns a malformed name unchanged so the validator can quote what was written", () => {
    for (const malformed of ["File_Text", "file text", "-leading", "trailing-", "Mixed-Case", ""]) {
      expect(toLucideIconName(malformed)).toBe(malformed)
    }
  })
})

describe("isLegacyKebabIconName", () => {
  it("flags a name that only resolves after normalization", () => {
    expect(isLegacyKebabIconName("file-text", isKnown)).toBe(true)
  })

  it("does not flag a name that already resolves", () => {
    expect(isLegacyKebabIconName("FileText", isKnown)).toBe(false)
  })

  it("does not flag a name that resolves neither way", () => {
    expect(isLegacyKebabIconName("not-an-icon-at-all", isKnown)).toBe(false)
  })
})
