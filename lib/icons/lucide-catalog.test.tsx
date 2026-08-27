import { createRef } from "react"
import { render, screen } from "@testing-library/react"

import { getLucideIcon, hasLucideIcon, lucideIcons } from "./lucide-catalog"

describe("lucide catalog", () => {
  it("resolves known names and rejects unknown names", () => {
    expect(hasLucideIcon("FileText")).toBe(true)
    expect(hasLucideIcon("NotARealIcon")).toBe(false)
    expect(getLucideIcon("NotARealIcon")).toBeNull()
  })

  it("caches component identities", () => {
    expect(getLucideIcon("Sparkles")).toBe(getLucideIcon("Sparkles"))
  })

  it("renders Lucide-compatible SVG props and forwards refs", () => {
    const Icon = getLucideIcon("FileText")!
    const ref = createRef<SVGSVGElement>()
    render(<Icon ref={ref} data-testid="icon" size={32} color="red" strokeWidth={4} />)

    const svg = screen.getByTestId("icon")
    expect(svg).toHaveAttribute("width", "32")
    expect(svg).toHaveAttribute("height", "32")
    expect(svg).toHaveAttribute("stroke", "red")
    expect(svg).toHaveAttribute("stroke-width", "4")
    expect(svg).toHaveAttribute("aria-hidden", "true")
    expect(svg).toHaveClass("lucide", "lucide-file-text")
    expect(ref.current).toBe(svg)
  })

  it("honors absolute stroke width and accessible labels", () => {
    const Icon = getLucideIcon("Sparkles")!
    render(
      <Icon
        data-testid="icon"
        size={48}
        strokeWidth={2}
        absoluteStrokeWidth
        aria-label="sparkles"
      />
    )

    const svg = screen.getByTestId("icon")
    expect(svg).toHaveAttribute("stroke-width", "1")
    expect(svg).not.toHaveAttribute("aria-hidden")
  })

  it("exposes the same icons as an indexable record", () => {
    // Render sites index this instead of calling `getLucideIcon`, so the two
    // must answer identically — same component, same cache.
    expect(lucideIcons.Sparkles).toBe(getLucideIcon("Sparkles"))
    expect(lucideIcons.NotAnIcon).toBeUndefined()
  })

  it("answers `in` and enumeration, not just reads", () => {
    // A `get`-only proxy looks correct until something enumerates it: `in`
    // would answer false for a real icon and `Object.keys` would report none.
    expect("Sparkles" in lucideIcons).toBe(true)
    expect("NotAnIcon" in lucideIcons).toBe(false)
    expect(Object.keys(lucideIcons)).toContain("Sparkles")
  })
})
