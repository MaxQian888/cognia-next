/**
 * @jest-environment jsdom
 */

import { act, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./dropdown-menu"

// Radix's trigger opens on pointerdown / keydown only. These pin the shared
// wrapper's click-only activation path — the one assistive technology and the
// agent-debug bridge use — without breaking the pointer and keyboard paths.

function Menu({
  onItem = () => {},
  onTriggerClick,
}: {
  onItem?: () => void
  onTriggerClick?: (event: React.MouseEvent<HTMLButtonElement>) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" onClick={onTriggerClick}>
          Row actions
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem onClick={onItem}>Open details</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// `hidden: true` because an open modal menu aria-hides everything outside it,
// the trigger included.
const trigger = () => screen.getByRole("button", { name: "Row actions", hidden: true })

describe("DropdownMenuTrigger click activation", () => {
  it("opens on a bare element.click()", () => {
    render(<Menu />)
    act(() => trigger().click())
    expect(screen.getByRole("menuitem", { name: "Open details" })).toBeInTheDocument()
    expect(trigger()).toHaveAttribute("data-state", "open")
  })

  it("opens on a plain mouse-event click sequence with no pointer events", () => {
    render(<Menu />)
    fireEvent.mouseDown(trigger())
    fireEvent.mouseUp(trigger())
    fireEvent.click(trigger())
    expect(screen.getByRole("menuitem", { name: "Open details" })).toBeInTheDocument()
  })

  it("toggles closed on a second click-only activation, like Enter does", () => {
    render(<Menu />)
    act(() => trigger().click())
    expect(trigger()).toHaveAttribute("data-state", "open")
    act(() => trigger().click())
    expect(trigger()).toHaveAttribute("data-state", "closed")
  })

  it("opens exactly once for a real pointer click (no double toggle)", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(<Menu />)
    await user.click(trigger())
    expect(trigger()).toHaveAttribute("data-state", "open")
    expect(screen.getByRole("menuitem", { name: "Open details" })).toBeInTheDocument()
  })

  it("opens exactly once when the pointer press's click reaches the trigger", () => {
    render(<Menu />)
    fireEvent.pointerDown(trigger(), { button: 0, ctrlKey: false })
    fireEvent.click(trigger())
    expect(trigger()).toHaveAttribute("data-state", "open")
  })

  it("still opens from the keyboard", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(<Menu />)
    trigger().focus()
    await user.keyboard("{Enter}")
    expect(screen.getByRole("menuitem", { name: "Open details" })).toBeInTheDocument()
  })

  it("runs the chosen item after a click-only open", async () => {
    const onItem = jest.fn()
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(<Menu onItem={onItem} />)
    act(() => trigger().click())
    await user.click(screen.getByRole("menuitem", { name: "Open details" }))
    expect(onItem).toHaveBeenCalledTimes(1)
  })

  it("leaves the menu closed when the trigger's own click handler prevents it", () => {
    render(<Menu onTriggerClick={(event) => event.preventDefault()} />)
    act(() => trigger().click())
    expect(trigger()).toHaveAttribute("data-state", "closed")
  })

  it("reports a click-only open through a controlled onOpenChange", () => {
    const onOpenChange = jest.fn()
    function Controlled() {
      const [open, setOpen] = useState(false)
      return (
        <DropdownMenu
          open={open}
          onOpenChange={(next) => {
            onOpenChange(next)
            setOpen(next)
          }}
        >
          <DropdownMenuTrigger>Row actions</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem>Open details</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )
    }
    render(<Controlled />)
    act(() => trigger().click())
    expect(onOpenChange).toHaveBeenCalledWith(true)
    expect(screen.getByRole("menuitem", { name: "Open details" })).toBeInTheDocument()
  })

  it("honours defaultOpen", () => {
    render(
      <DropdownMenu defaultOpen>
        <DropdownMenuTrigger>Row actions</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Open details</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    )
    expect(screen.getByRole("menuitem", { name: "Open details" })).toBeInTheDocument()
  })
})
