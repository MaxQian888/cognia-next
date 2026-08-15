import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import * as mod from "./details-block"
import { DetailsBlock } from "./details-block"

describe("DetailsBlock", () => {
  it("starts closed by default and opens on trigger click", async () => {
    const user = userEvent.setup()
    render(
      <DetailsBlock summary="More">
        <span>hidden body</span>
      </DetailsBlock>
    )
    const trigger = screen.getByRole("button", { name: /More/ })
    expect(trigger).toHaveAttribute("data-state", "closed")
    await user.click(trigger)
    expect(trigger).toHaveAttribute("data-state", "open")
    expect(screen.getByText("hidden body")).toBeVisible()
  })

  it("honours defaultOpen and the variant paddings", () => {
    render(
      <DetailsBlock summary="Open" defaultOpen variant="filled" className="extra">
        body
      </DetailsBlock>
    )
    const trigger = screen.getByRole("button", { name: /Open/ })
    expect(trigger).toHaveAttribute("data-state", "open")
    expect(trigger.className).toContain("p-3")
    // Root carries the variant + merged className.
    const root = trigger.parentElement as HTMLElement
    expect(root.className).toContain("bg-muted/30")
    expect(root.className).toContain("extra")
  })

  it("uses the inset body padding for the default variant", () => {
    render(
      <DetailsBlock summary="Plain" defaultOpen>
        body
      </DetailsBlock>
    )
    const trigger = screen.getByRole("button", { name: /Plain/ })
    expect(trigger.className).not.toContain("p-3")
    const content = screen.getByText("body").parentElement as HTMLElement
    expect(content.className).toContain("pl-6")
  })

  it("exposes only the disclosure block (ADR-0127 removed the story-only DetailsGroup)", () => {
    expect(Object.keys(mod).sort()).toEqual(["DetailsBlock", "default"])
    expect(mod.default).toBe(DetailsBlock)
  })
})
