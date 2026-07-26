import { render, screen } from "@testing-library/react"

import { Separator } from "./separator"

describe("Separator", () => {
  it("is decorative by default, so screen readers skip it", () => {
    render(<Separator />)

    // Radix swaps role="separator" for role="none" when decorative. Pinned
    // because a panel full of announced rules is the regression this default
    // exists to prevent.
    expect(screen.queryByRole("separator")).not.toBeInTheDocument()
    const rule = document.querySelector("[data-slot='separator']")
    expect(rule).toHaveAttribute("role", "none")
    expect(rule).toHaveAttribute("data-orientation", "horizontal")
  })

  it("claims the separator role when the caller opts out of decorative", () => {
    render(<Separator decorative={false} />)

    const rule = screen.getByRole("separator")
    expect(rule).toHaveAttribute("data-slot", "separator")
    // A horizontal separator is the ARIA default, so Radix omits the redundant
    // aria-orientation.
    expect(rule).not.toHaveAttribute("aria-orientation")
  })

  it("announces orientation only when vertical and semantic", () => {
    render(<Separator decorative={false} orientation="vertical" />)

    const rule = screen.getByRole("separator")
    expect(rule).toHaveAttribute("aria-orientation", "vertical")
    expect(rule).toHaveAttribute("data-orientation", "vertical")
  })

  it("mirrors orientation onto data-orientation for the thickness rules", () => {
    render(<Separator orientation="vertical" />)

    const rule = document.querySelector("[data-slot='separator']")
    expect(rule).toHaveAttribute("data-orientation", "vertical")
    // The width/height branch lives in CSS, not JS — both variants ship in the
    // one class string and the attribute picks the winner.
    expect(rule?.className).toContain("data-[orientation=vertical]:w-px")
    expect(rule?.className).toContain("data-[orientation=horizontal]:h-px")
  })

  it("merges caller classes onto the rule instead of dropping them", () => {
    render(<Separator decorative={false} className="my-4 bg-primary" />)

    const rule = screen.getByRole("separator")
    expect(rule.className).toContain("my-4")
    // cn() resolved bg-border vs bg-primary rather than emitting both.
    expect(rule.className).toContain("bg-primary")
    expect(rule.className).not.toContain("bg-border")
  })
})
