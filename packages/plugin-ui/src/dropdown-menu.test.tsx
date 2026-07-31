import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./dropdown-menu"

// Radix's dropdown opens on pointerdown with a `pointerType` check that
// `fireEvent.click` does not satisfy — userEvent is mandatory here, not a
// stylistic preference (see the repo's jest-gotchas note on Radix).
const setup = () => userEvent.setup()

describe("DropdownMenu", () => {
  it("keeps the menu closed until the trigger is activated", async () => {
    const user = setup()
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Run</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    )

    // Portalled content is not merely hidden — it is unmounted while closed,
    // which is exactly what makes the host, not the plugin, own the layer.
    expect(screen.queryByRole("menu")).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Open" }))
    expect(await screen.findByRole("menu")).toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: "Run" })).toBeInTheDocument()
  })

  it("routes a selection back to the caller and closes", async () => {
    const user = setup()
    const onSelect = jest.fn()
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onSelect={onSelect}>Run</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    )

    await user.click(screen.getByRole("button", { name: "Open" }))
    await user.click(await screen.findByRole("menuitem", { name: "Run" }))

    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole("menu")).not.toBeInTheDocument()
  })

  it("marks a disabled item and swallows its selection", async () => {
    const user = setup()
    const onSelect = jest.fn()
    render(
      <DropdownMenu defaultOpen>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem disabled onSelect={onSelect}>
            Run
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    )

    const item = await screen.findByRole("menuitem", { name: "Run" })
    expect(item).toHaveAttribute("aria-disabled", "true")
    await user.click(item)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it("carries the destructive variant and inset as data attributes", async () => {
    render(
      <DropdownMenu defaultOpen>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem variant="destructive" inset>
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    )

    const item = await screen.findByRole("menuitem", { name: "Delete" })
    expect(item).toHaveAttribute("data-variant", "destructive")
    expect(item).toHaveAttribute("data-inset", "true")
    expect(item).toHaveAttribute("data-slot", "dropdown-menu-item")
  })

  it("toggles a checkbox item and reports the next state", async () => {
    const user = setup()
    const onCheckedChange = jest.fn()
    render(
      <DropdownMenu defaultOpen>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuCheckboxItem checked onCheckedChange={onCheckedChange}>
            Wrap lines
          </DropdownMenuCheckboxItem>
        </DropdownMenuContent>
      </DropdownMenu>
    )

    const item = await screen.findByRole("menuitemcheckbox", { name: "Wrap lines" })
    expect(item).toHaveAttribute("data-state", "checked")
    await user.click(item)
    expect(onCheckedChange).toHaveBeenCalledWith(false)
  })

  it("reports the picked value from a radio group", async () => {
    const user = setup()
    const onValueChange = jest.fn()
    render(
      <DropdownMenu defaultOpen>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuRadioGroup value="asc" onValueChange={onValueChange}>
            <DropdownMenuRadioItem value="asc">Ascending</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="desc">Descending</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    )

    expect(await screen.findByRole("menuitemradio", { name: "Ascending" })).toHaveAttribute(
      "data-state",
      "checked"
    )
    await user.click(screen.getByRole("menuitemradio", { name: "Descending" }))
    expect(onValueChange).toHaveBeenCalledWith("desc")
  })

  it("renders label, separator, group and shortcut without polluting item names", async () => {
    render(
      <DropdownMenu defaultOpen>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuLabel inset>Actions</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem>
              Save
              <DropdownMenuShortcut>Ctrl+S</DropdownMenuShortcut>
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    )

    expect(await screen.findByText("Actions")).toHaveAttribute("data-inset", "true")
    expect(screen.getByRole("separator")).toHaveAttribute("data-slot", "dropdown-menu-separator")
    expect(screen.getByRole("group")).toBeInTheDocument()
    // The shortcut is inside the item, so it DOES join the accessible name —
    // pin the exact string so a future role change on it is caught here.
    expect(screen.getByRole("menuitem", { name: "Save Ctrl+S" })).toBeInTheDocument()
    expect(screen.getByText("Ctrl+S")).toHaveAttribute("data-slot", "dropdown-menu-shortcut")
  })

  it("opens a submenu from its sub-trigger", async () => {
    const user = setup()
    render(
      <DropdownMenu defaultOpen>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger inset>More</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem>Nested</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>
    )

    const subTrigger = await screen.findByRole("menuitem", { name: "More" })
    expect(subTrigger).toHaveAttribute("data-inset", "true")
    expect(screen.queryByRole("menuitem", { name: "Nested" })).not.toBeInTheDocument()

    await user.click(subTrigger)
    expect(await screen.findByRole("menuitem", { name: "Nested" })).toBeInTheDocument()
  })

  it("renders through an explicit DropdownMenuPortal", async () => {
    render(
      <DropdownMenu defaultOpen>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuPortal>
          <DropdownMenuContent>
            <DropdownMenuItem>Run</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenuPortal>
      </DropdownMenu>
    )

    // The explicit portal is exported for the second-boundary case; nesting it
    // around Content (which portals on its own) must stay a no-op rather than
    // double-mounting or swallowing the menu.
    expect(await screen.findByRole("menuitem", { name: "Run" })).toBeInTheDocument()
    expect(screen.getAllByRole("menu")).toHaveLength(1)
  })

  it("merges caller classes onto the content instead of dropping them", async () => {
    render(
      <DropdownMenu defaultOpen>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent className="p-4">
          <DropdownMenuItem>Run</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    )

    const menu = await screen.findByRole("menu")
    expect(menu).toHaveAttribute("data-slot", "dropdown-menu-content")
    // cn() resolved p-1 vs p-4 rather than emitting both.
    expect(menu.className).toContain("p-4")
    expect(menu.className).not.toContain("p-1")
  })
})
