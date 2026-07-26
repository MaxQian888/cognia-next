import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "./popover"

// Radix gates open/close on pointer events with a `pointerType` check that
// fireEvent does not satisfy — userEvent is required (repo jest-gotchas #4).
const setup = () => userEvent.setup()

describe("Popover", () => {
  it("mounts its content only once opened", async () => {
    const user = setup()
    render(
      <Popover>
        <PopoverTrigger>Details</PopoverTrigger>
        <PopoverContent>Body</PopoverContent>
      </Popover>
    )

    expect(screen.queryByText("Body")).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Details" }))
    expect(await screen.findByText("Body")).toBeInTheDocument()
  })

  it("reflects open state on the trigger for assistive tech", async () => {
    const user = setup()
    render(
      <Popover>
        <PopoverTrigger>Details</PopoverTrigger>
        <PopoverContent>Body</PopoverContent>
      </Popover>
    )

    const trigger = screen.getByRole("button", { name: "Details" })
    expect(trigger).toHaveAttribute("aria-expanded", "false")
    await user.click(trigger)
    expect(trigger).toHaveAttribute("aria-expanded", "true")
  })

  it("closes on Escape and tells the caller", async () => {
    const user = setup()
    const onOpenChange = jest.fn()
    render(
      <Popover defaultOpen onOpenChange={onOpenChange}>
        <PopoverTrigger>Details</PopoverTrigger>
        <PopoverContent>Body</PopoverContent>
      </Popover>
    )

    expect(await screen.findByText("Body")).toBeInTheDocument()
    await user.keyboard("{Escape}")
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(screen.queryByText("Body")).not.toBeInTheDocument()
  })

  it("stays open under caller control when open is pinned", async () => {
    const user = setup()
    const onOpenChange = jest.fn()
    render(
      <Popover open onOpenChange={onOpenChange}>
        <PopoverTrigger>Details</PopoverTrigger>
        <PopoverContent>Body</PopoverContent>
      </Popover>
    )

    await user.keyboard("{Escape}")
    // Controlled: Radix asks, the caller decides — content must survive.
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(screen.getByText("Body")).toBeInTheDocument()
  })

  it("exposes a NON-modal dialog and plain header slots", async () => {
    render(
      <Popover defaultOpen>
        <PopoverTrigger>Details</PopoverTrigger>
        <PopoverContent>
          <PopoverHeader>
            <PopoverTitle>Rename</PopoverTitle>
            <PopoverDescription>Pick a new name</PopoverDescription>
          </PopoverHeader>
        </PopoverContent>
      </Popover>
    )

    // Radix gives Popover.Content role="dialog" but never aria-modal: the rest
    // of the page stays reachable. Pinned because a plugin that needs a REAL
    // modal must ask the host for one rather than assume this is it.
    const content = await screen.findByRole("dialog")
    expect(content).not.toHaveAttribute("aria-modal")
    expect(content).toHaveAttribute("data-slot", "popover-content")

    // Header/Title/Description are plain elements — no heading role, and no
    // aria-labelledby wiring back onto the dialog, which the caller owns.
    const title = screen.getByText("Rename")
    expect(title).toHaveAttribute("data-slot", "popover-title")
    expect(screen.queryByRole("heading")).not.toBeInTheDocument()
    expect(content).not.toHaveAttribute("aria-labelledby")
    expect(screen.getByText("Pick a new name")).toHaveAttribute("data-slot", "popover-description")
    expect(title.parentElement).toHaveAttribute("data-slot", "popover-header")
  })

  it("positions against an explicit anchor when one is supplied", async () => {
    render(
      <Popover defaultOpen>
        <PopoverAnchor>
          <span>Cell</span>
        </PopoverAnchor>
        <PopoverTrigger>Details</PopoverTrigger>
        <PopoverContent>Body</PopoverContent>
      </Popover>
    )

    // The anchor is a rendered element in the plugin's own tree; only the
    // content leaves via the host-owned portal.
    expect(screen.getByText("Cell").parentElement).toHaveAttribute("data-slot", "popover-anchor")
    expect(await screen.findByText("Body")).toBeInTheDocument()
  })

  it("merges caller classes onto the content instead of dropping them", async () => {
    render(
      <Popover defaultOpen>
        <PopoverTrigger>Details</PopoverTrigger>
        <PopoverContent className="w-40">Body</PopoverContent>
      </Popover>
    )

    const content = (await screen.findByText("Body")).closest("[data-slot='popover-content']")
    expect(content).not.toBeNull()
    // cn() resolved w-72 vs w-40 rather than emitting both.
    expect(content?.className).toContain("w-40")
    expect(content?.className).not.toContain("w-72")
  })
})
