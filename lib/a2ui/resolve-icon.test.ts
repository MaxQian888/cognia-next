/**
 * Tests for resolveIcon utility
 */

import { resolveIcon } from "./resolve-icon"
import { icons } from "lucide-react"

describe("resolveIcon", () => {
  it("returns null when no name is given", () => {
    expect(resolveIcon()).toBeNull()
    expect(resolveIcon(undefined)).toBeNull()
    expect(resolveIcon("")).toBeNull()
  })

  it("resolves a known Lucide icon name to its component", () => {
    const Resolved = resolveIcon("Sparkles")
    expect(Resolved).toBe(icons.Sparkles)
    expect(typeof Resolved).toBe("object")
  })

  it("returns null for an unknown icon name", () => {
    expect(resolveIcon("NotARealIcon")).toBeNull()
  })

  it("is case-sensitive (lucide names are PascalCase)", () => {
    // `sparkles` (lower) is not a key on the icons map.
    expect(resolveIcon("sparkles")).toBeNull()
    expect(resolveIcon("Sparkles")).toBe(icons.Sparkles)
  })
})
