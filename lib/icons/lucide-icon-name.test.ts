import { hasLucideExport, hasLucideIcon, toCatalogIconName } from "./lucide-catalog"
import { isLegacyKebabIconName, toLucideIconName } from "./lucide-icon-name"

/**
 * The predicate that decides installability — `isExportedLucideIcon` in
 * `lib/plugin/core/validation.ts` — not `lucide-react`'s `icons` record.
 * That record is keyed by canonical icon name only, so it answers "no" for an
 * icon lucide has renamed while keeping the old spelling as an export alias
 * (`History` → `RotateCcwClock`). Asserting against it made this suite fail on
 * a name a plugin can legitimately declare.
 */
const isKnown = (name: string) => hasLucideIcon(name) || hasLucideExport(name)

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
      // And it has to draw, not merely validate: the catalog must be able to
      // name the entry the component comes from.
      expect(toCatalogIconName(legacy)).not.toBeNull()
    }
  })

  it("resolves a legacy name whose icon lucide has since renamed", () => {
    // `history` is the case the allowlist loop above cannot show on its own:
    // lucide renamed the icon to `rotate-ccw-clock` and kept `History` only as
    // an export alias, so the PascalCase form is not a canonical icon name.
    expect(toLucideIconName("history")).toBe("History")
    expect(hasLucideIcon("History")).toBe(false)
    expect(hasLucideExport("History")).toBe(true)
    expect(toCatalogIconName("history")).toBe("RotateCcwClock")
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
