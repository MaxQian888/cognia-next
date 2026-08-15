import { render, screen } from "@testing-library/react"
import * as mod from "./kbd-inline"
import { KbdInline } from "./kbd-inline"

describe("KbdInline", () => {
  it("renders the key label inside a kbd element with the default variant", () => {
    render(<KbdInline>Enter</KbdInline>)
    const kbd = screen.getByText("Enter")
    expect(kbd.tagName.toLowerCase()).toBe("kbd")
    expect(kbd.className).toContain("border-border")
    expect(kbd.className).toContain("shadow-sm")
  })

  it("applies the outline and ghost variants and merges className", () => {
    const { rerender } = render(
      <KbdInline variant="outline" className="extra">
        A
      </KbdInline>
    )
    expect(screen.getByText("A").className).toContain("bg-transparent")
    expect(screen.getByText("A").className).toContain("extra")
    rerender(<KbdInline variant="ghost">B</KbdInline>)
    expect(screen.getByText("B").className).toContain("bg-muted/50")
  })

  it("exposes only the inline renderer (ADR-0127 removed the test-only chord helpers)", () => {
    // `KeyboardShortcut` / `parseShortcut` had zero production call sites; the
    // markdown `kbd` override mounts `KbdInline` only.
    expect(Object.keys(mod).sort()).toEqual(["KbdInline", "default"])
    expect(mod.default).toBe(KbdInline)
  })
})
