import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { DeviceSectionNav } from "./device-section-nav"

const ITEMS = [
  { anchor: "device-section-access", label: "Access" },
  { anchor: "device-section-identity", label: "Identity" },
  { anchor: "device-section-placement", label: "Placement" },
]

describe("DeviceSectionNav", () => {
  it("is a labelled navigation landmark with one chip per card", () => {
    render(<DeviceSectionNav items={ITEMS} activeAnchor={null} onJump={jest.fn()} />)
    const nav = screen.getByRole("navigation", { name: "Jump to a section" })
    expect(nav).toBeInTheDocument()
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Access",
      "Identity",
      "Placement",
    ])
  })

  it("marks the card in view as the current location, and only that one", () => {
    render(
      <DeviceSectionNav items={ITEMS} activeAnchor="device-section-identity" onJump={jest.fn()} />
    )
    expect(screen.getByRole("button", { name: "Identity" })).toHaveAttribute(
      "aria-current",
      "location"
    )
    expect(screen.getByRole("button", { name: "Access" })).not.toHaveAttribute("aria-current")
  })

  it("jumps to the card a chip names", async () => {
    const onJump = jest.fn()
    render(<DeviceSectionNav items={ITEMS} activeAnchor={null} onJump={onJump} />)
    await userEvent.click(screen.getByRole("button", { name: "Placement" }))
    expect(onJump).toHaveBeenCalledWith("device-section-placement")
  })

  it("renders nothing for a single card, which needs no table of contents", () => {
    const { container } = render(
      <DeviceSectionNav items={ITEMS.slice(0, 1)} activeAnchor={null} onJump={jest.fn()} />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it("scrolls the strip sideways to keep the marked chip in view", () => {
    const { rerender } = render(
      <DeviceSectionNav items={ITEMS} activeAnchor={null} onJump={jest.fn()} />
    )
    const strip = screen.getByRole("navigation").firstElementChild as HTMLElement
    Object.defineProperty(strip, "clientWidth", { configurable: true, value: 100 })
    const chip = screen.getByRole("button", { name: "Placement" })
    Object.defineProperty(chip, "offsetLeft", { configurable: true, value: 180 })
    Object.defineProperty(chip, "offsetWidth", { configurable: true, value: 60 })

    rerender(
      <DeviceSectionNav items={ITEMS} activeAnchor="device-section-placement" onJump={jest.fn()} />
    )
    // Right edge 240, less the 100px it can show, plus breathing room.
    expect(strip.scrollLeft).toBe(148)
  })
})
