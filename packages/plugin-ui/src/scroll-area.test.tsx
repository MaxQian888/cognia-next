import { render, screen } from "@testing-library/react"

import { ScrollArea, ScrollBar } from "./scroll-area"

const rootOf = (child: HTMLElement) => child.closest("[data-slot='scroll-area']")
const viewportOf = (child: HTMLElement) => child.closest("[data-slot='scroll-area-viewport']")
const scrollbars = () =>
  Array.from(document.querySelectorAll<HTMLElement>("[data-slot='scroll-area-scrollbar']"))

describe("ScrollArea", () => {
  it("puts children in the viewport, not directly on the root", () => {
    render(
      <ScrollArea>
        <p>Row</p>
      </ScrollArea>
    )

    // The nesting matters: content on the root would scroll the host's own
    // container instead of the plugin's slot.
    const viewport = viewportOf(screen.getByText("Row"))
    expect(viewport).not.toBeNull()
    expect(viewport?.parentElement).toHaveAttribute("data-slot", "scroll-area")
  })

  it("clips overflow on the root so a plugin cannot push the host's layout", () => {
    render(
      <ScrollArea>
        <p>Row</p>
      </ScrollArea>
    )

    const root = rootOf(screen.getByText("Row"))
    expect(root?.className).toContain("overflow-hidden")
    expect(root?.className).toContain("relative")
  })

  it("merges caller classes onto the root instead of dropping them", () => {
    render(
      <ScrollArea className="h-40 overflow-visible">
        <p>Row</p>
      </ScrollArea>
    )

    const root = rootOf(screen.getByText("Row"))
    expect(root?.className).toContain("h-40")
    // cn() resolved overflow-hidden vs overflow-visible rather than emitting both.
    expect(root?.className).toContain("overflow-visible")
    expect(root?.className).not.toContain("overflow-hidden")
  })

  it("forwards Radix root props such as type", () => {
    render(
      <ScrollArea type="always" id="log">
        <p>Row</p>
      </ScrollArea>
    )

    expect(rootOf(screen.getByText("Row"))).toHaveAttribute("id", "log")
    // type="always" is what makes the built-in scrollbar mount without layout.
    expect(scrollbars()).toHaveLength(1)
  })

  it("ships exactly one built-in vertical scrollbar", () => {
    render(
      <ScrollArea type="always">
        <p>Row</p>
      </ScrollArea>
    )

    const [bar] = scrollbars()
    expect(bar).toHaveAttribute("data-orientation", "vertical")
    expect(bar.className).toContain("w-2.5")
    expect(bar.className).not.toContain("h-2.5")
    // The thumb is deliberately not asserted: Radix gates it on a measured
    // overflow ratio, and jsdom reports every box as zero-sized, so it never
    // mounts here. Its geometry is a browser-only concern.
  })
})

describe("ScrollBar", () => {
  it("switches to a horizontal track when asked", () => {
    // ScrollBar reads its geometry from the Root context, not from DOM
    // position, so composing one inside the area is enough to exercise the
    // orientation branch a caller hits when building their own Root.
    render(
      <ScrollArea type="always">
        <ScrollBar orientation="horizontal" />
      </ScrollArea>
    )

    const horizontal = scrollbars().find(
      (bar) => bar.getAttribute("data-orientation") === "horizontal"
    )
    expect(horizontal).toBeDefined()
    expect(horizontal?.className).toContain("h-2.5")
    expect(horizontal?.className).toContain("flex-col")
    expect(horizontal?.className).not.toContain("w-2.5")
  })

  it("merges caller classes onto the bar instead of dropping them", () => {
    render(
      <ScrollArea type="always">
        <ScrollBar className="w-4" />
      </ScrollArea>
    )

    const custom = scrollbars().find((bar) => bar.className.includes("w-4"))
    expect(custom).toBeDefined()
    // cn() resolved w-2.5 vs w-4 rather than emitting both.
    expect(custom?.className).not.toContain("w-2.5")
  })
})
