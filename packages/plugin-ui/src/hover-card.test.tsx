import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { HoverCard, HoverCardContent, HoverCardTrigger } from "./hover-card"

describe("HoverCard", () => {
  it("renders nothing until it opens", () => {
    render(
      <HoverCard>
        <HoverCardTrigger>Ada</HoverCardTrigger>
        <HoverCardContent>Analytical Engine</HoverCardContent>
      </HoverCard>
    )
    expect(screen.queryByText("Analytical Engine")).not.toBeInTheDocument()
  })

  it("opens on pointer hover over the trigger", async () => {
    const user = userEvent.setup()
    render(
      // openDelay 0: Radix's default 700ms hover intent would otherwise make
      // this test wait on a real timer.
      <HoverCard openDelay={0}>
        <HoverCardTrigger>Ada</HoverCardTrigger>
        <HoverCardContent>Analytical Engine</HoverCardContent>
      </HoverCard>
    )

    await user.hover(screen.getByText("Ada"))
    expect(await screen.findByText("Analytical Engine")).toBeInTheDocument()
  })

  it("mirrors its open state to the caller", async () => {
    const user = userEvent.setup()
    const onOpenChange = jest.fn()
    render(
      <HoverCard openDelay={0} onOpenChange={onOpenChange}>
        <HoverCardTrigger>Ada</HoverCardTrigger>
        <HoverCardContent>Analytical Engine</HoverCardContent>
      </HoverCard>
    )

    await user.hover(screen.getByText("Ada"))
    await screen.findByText("Analytical Engine")
    expect(onOpenChange).toHaveBeenCalledWith(true)
  })

  /**
   * Controlled rendering is the deterministic way to assert the content's own
   * wiring: it puts the card in the DOM without depending on Radix's hover
   * intent timers.
   */
  it("portals its content out of the trigger's subtree when open", () => {
    const { container } = render(
      <HoverCard open>
        <HoverCardTrigger>Ada</HoverCardTrigger>
        <HoverCardContent>Analytical Engine</HoverCardContent>
      </HoverCard>
    )

    const content = screen.getByText("Analytical Engine")
    expect(content).toHaveAttribute("data-slot", "hover-card-content")
    expect(content).toHaveAttribute("data-state", "open")
    // The point of the component: a plugin has no `createPortal`, so escaping
    // its own slot's stacking/overflow context is only possible because Radix's
    // portal (host-mounted) moved the node outside the rendered subtree.
    expect(container.contains(content)).toBe(false)
    expect(document.body.contains(content)).toBe(true)
  })

  it("merges caller classes rather than appending a conflicting utility", () => {
    render(
      <HoverCard open>
        <HoverCardTrigger>Ada</HoverCardTrigger>
        <HoverCardContent className="w-96">Analytical Engine</HoverCardContent>
      </HoverCard>
    )

    const content = screen.getByText("Analytical Engine")
    expect(content.className).toContain("w-96")
    // cn() resolved w-64 vs w-96 instead of emitting both.
    expect(content.className).not.toContain("w-64")
  })

  it("keeps the caller's align and side overrides", () => {
    render(
      <HoverCard open>
        <HoverCardTrigger>Ada</HoverCardTrigger>
        <HoverCardContent align="start" side="bottom">
          Analytical Engine
        </HoverCardContent>
      </HoverCard>
    )

    const content = screen.getByText("Analytical Engine")
    expect(content).toHaveAttribute("data-align", "start")
    expect(content).toHaveAttribute("data-side", "bottom")
  })

  it("renders the trigger as its child element when asChild is set", () => {
    render(
      <HoverCard>
        <HoverCardTrigger asChild>
          <a href="/ada">Ada</a>
        </HoverCardTrigger>
        <HoverCardContent>Analytical Engine</HoverCardContent>
      </HoverCard>
    )

    expect(screen.getByRole("link", { name: "Ada" })).toHaveAttribute(
      "data-slot",
      "hover-card-trigger"
    )
  })
})
