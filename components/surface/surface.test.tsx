import { render, screen } from "@testing-library/react"
import { Card } from "@/components/ui/card"
import { Alert } from "@/components/ui/alert"
import { Surface } from "./surface"

describe("Surface", () => {
  it("declares its tier and reads the tier variable for its background", () => {
    render(<Surface data-testid="s" layer="overlay" />)
    const el = screen.getByTestId("s")
    expect(el).toHaveAttribute("data-surface-layer", "overlay")
    expect(el.className).toContain("bg-[var(--surface-bg)]")
  })

  it("defaults to the raised tier", () => {
    render(<Surface data-testid="s" />)
    expect(screen.getByTestId("s")).toHaveAttribute("data-surface-layer", "raised")
  })

  it("maps every named radius step to a utility", () => {
    for (const [radius, cls] of [
      ["control", "rounded-control"],
      ["panel", "rounded-panel"],
      ["stage", "rounded-stage"],
      ["pill", "rounded-pill"],
      ["none", "rounded-none"],
    ] as const) {
      const { unmount } = render(<Surface data-testid="s" radius={radius} />)
      expect(screen.getByTestId("s").className).toContain(cls)
      unmount()
    }
  })

  it("emits no radius class for `inherit` so the caller keeps its own", () => {
    render(<Surface data-testid="s" radius="inherit" className="rounded-lg" />)
    const cls = screen.getByTestId("s").className
    expect(cls).toContain("rounded-lg")
    expect(cls).not.toMatch(/rounded-(control|panel|stage|pill|none)/)
  })

  /**
   * `elevation` maps to the shared `[data-elevation]` scale. Omitting it must
   * stay a no-op, or every adopting primitive would gain a shadow it never had.
   */
  it("only writes data-elevation when asked", () => {
    const { rerender } = render(<Surface data-testid="s" />)
    expect(screen.getByTestId("s")).not.toHaveAttribute("data-elevation")
    rerender(<Surface data-testid="s" elevation={0} />)
    expect(screen.getByTestId("s")).toHaveAttribute("data-elevation", "0")
    rerender(<Surface data-testid="s" elevation={3} />)
    expect(screen.getByTestId("s")).toHaveAttribute("data-elevation", "3")
  })

  it("renders into the child under asChild", () => {
    render(
      <Surface asChild>
        <section data-testid="s" />
      </Surface>
    )
    const el = screen.getByTestId("s")
    expect(el.tagName).toBe("SECTION")
    expect(el).toHaveAttribute("data-surface-layer", "raised")
  })

  it("does not set a foreground colour, so a caller's text class cannot lose", () => {
    render(<Surface data-testid="s" className="text-destructive" />)
    const cls = screen.getByTestId("s").className
    expect(cls).toContain("text-destructive")
    expect(cls).not.toContain("--surface-fg")
  })
})

/**
 * Parity guard for the Soft pack (ADR-0148 decision 18). These primitives were
 * re-based onto `<Surface>` without their default appearance moving; the checks
 * below pin the exact substitutions so a later edit cannot quietly change what
 * ~559 Card call sites and every Alert render.
 */
describe("primitives re-based on Surface keep their default look", () => {
  it("Card trades bg-card + rounded-xl for the raised tier + rounded-stage", () => {
    render(<Card data-testid="card" />)
    const el = screen.getByTestId("card")
    // `rounded-stage` is max(0px, calc(var(--radius) + 4px)); `rounded-xl` was
    // calc(var(--radius) + 4px) — same value at every non-negative base.
    expect(el).toHaveAttribute("data-surface-layer", "raised")
    expect(el.className).toContain("rounded-stage")
    expect(el.className).toContain("text-card-foreground")
    expect(el.className).toContain("shadow-sm")
    expect(el.className).not.toContain("bg-card")
    expect(el.className).not.toContain("rounded-xl")
    // The data-slot the wallpaper stack and the component-style registry key
    // off must survive the re-base.
    expect(el).toHaveAttribute("data-slot", "card")
  })

  it("Card's settings-panel fork clears the tier by variable, not by repaint", () => {
    render(<Card data-testid="card" />)
    const cls = screen.getByTestId("card").className
    expect(cls).toContain("[[data-settings-panel]_&]:[--surface-bg:transparent]")
    expect(cls).not.toContain("[[data-settings-panel]_&]:bg-transparent")
  })

  it("Alert keeps rounded-lg and its per-variant foreground", () => {
    const { rerender } = render(<Alert data-testid="a" />)
    let el = screen.getByTestId("a")
    expect(el).toHaveAttribute("data-surface-layer", "raised")
    expect(el).toHaveAttribute("data-slot", "alert")
    expect(el.className).toContain("rounded-lg")
    expect(el.className).toContain("text-card-foreground")
    expect(el.className).not.toContain("bg-card")

    rerender(<Alert data-testid="a" variant="destructive" />)
    el = screen.getByTestId("a")
    expect(el.className).toContain("text-destructive")
    expect(el.className).not.toContain("bg-card")
  })
})
