/**
 * Tests for resolveIcon utility
 */

import { resolveIcon } from "./resolve-icon"

describe("resolveIcon", () => {
  it("returns null when no name is given", () => {
    expect(resolveIcon()).toBeNull()
    expect(resolveIcon(undefined)).toBeNull()
    expect(resolveIcon("")).toBeNull()
  })

  it("resolves a known Lucide icon name to its component", () => {
    const Resolved = resolveIcon("Sparkles")
    expect(typeof Resolved).toBe("object")
    expect(Resolved?.displayName).toBe("Sparkles")
  })

  it("returns null for an unknown icon name", () => {
    expect(resolveIcon("NotARealIcon")).toBeNull()
  })

  it("accepts the retired kebab-case spelling the plugin contract published", () => {
    // `PLUGIN_CONTEXT_PANEL_ICONS` shipped names like `file-text` and bare
    // lowercase words like `settings`, so a plugin pinned to either must keep
    // rendering rather than silently showing nothing.
    expect(resolveIcon("file-text")?.displayName).toBe("FileText")
    expect(resolveIcon("panel-right")?.displayName).toBe("PanelRight")
    expect(resolveIcon("sparkles")?.displayName).toBe("Sparkles")
  })

  it("prefers an exact match over the normalized one", () => {
    expect(resolveIcon("Sparkles")).toBe(resolveIcon("Sparkles"))
  })

  it("still returns null for a name that resolves neither way", () => {
    expect(resolveIcon("not-an-icon-at-all")).toBeNull()
    expect(resolveIcon("NotARealIcon")).toBeNull()
  })
})
