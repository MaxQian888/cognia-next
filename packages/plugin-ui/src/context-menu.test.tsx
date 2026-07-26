import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuPortal,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "./context-menu"

// A context menu anchors to the pointer, not to a control, so it opens on a
// raw `contextmenu` event rather than a click. userEvent has no right-click
// shorthand that survives Radix's virtual-reference positioning in jsdom, so
// open with fireEvent and drive everything after that with userEvent.
const openMenu = (name: string) => fireEvent.contextMenu(screen.getByText(name))

describe("ContextMenu", () => {
  it("stays unmounted until the region is right-clicked", async () => {
    render(
      <ContextMenu>
        <ContextMenuTrigger>Region</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem>Copy</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    )

    expect(screen.queryByRole("menu")).not.toBeInTheDocument()
    openMenu("Region")
    expect(await screen.findByRole("menu")).toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: "Copy" })).toBeInTheDocument()
  })

  it("does not put the trigger in the tab order", () => {
    render(
      <ContextMenu>
        <ContextMenuTrigger>Region</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem>Copy</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    )

    // The trigger is a hit area, not a control: giving it button semantics
    // would announce a press affordance that does nothing.
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
    expect(screen.getByText("Region")).toHaveAttribute("data-slot", "context-menu-trigger")
  })

  it("routes a selection back to the caller and closes", async () => {
    const user = userEvent.setup()
    const onSelect = jest.fn()
    render(
      <ContextMenu>
        <ContextMenuTrigger>Region</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={onSelect}>Copy</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    )

    openMenu("Region")
    await user.click(await screen.findByRole("menuitem", { name: "Copy" }))

    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole("menu")).not.toBeInTheDocument()
  })

  it("marks a disabled item and swallows its selection", async () => {
    const user = userEvent.setup()
    const onSelect = jest.fn()
    render(
      <ContextMenu>
        <ContextMenuTrigger>Region</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem disabled onSelect={onSelect}>
            Copy
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    )

    openMenu("Region")
    const item = await screen.findByRole("menuitem", { name: "Copy" })
    expect(item).toHaveAttribute("aria-disabled", "true")
    await user.click(item)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it("carries the destructive variant and inset as data attributes", async () => {
    render(
      <ContextMenu>
        <ContextMenuTrigger>Region</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem variant="destructive" inset>
            Delete
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    )

    openMenu("Region")
    const item = await screen.findByRole("menuitem", { name: "Delete" })
    expect(item).toHaveAttribute("data-variant", "destructive")
    expect(item).toHaveAttribute("data-inset", "true")
    expect(item).toHaveAttribute("data-slot", "context-menu-item")
  })

  it("toggles a checkbox item and reports the next state", async () => {
    const user = userEvent.setup()
    const onCheckedChange = jest.fn()
    render(
      <ContextMenu>
        <ContextMenuTrigger>Region</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuCheckboxItem checked onCheckedChange={onCheckedChange}>
            Show hidden
          </ContextMenuCheckboxItem>
        </ContextMenuContent>
      </ContextMenu>
    )

    openMenu("Region")
    const item = await screen.findByRole("menuitemcheckbox", { name: "Show hidden" })
    expect(item).toHaveAttribute("data-state", "checked")
    await user.click(item)
    expect(onCheckedChange).toHaveBeenCalledWith(false)
  })

  it("reports the picked value from a radio group", async () => {
    const user = userEvent.setup()
    const onValueChange = jest.fn()
    render(
      <ContextMenu>
        <ContextMenuTrigger>Region</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuRadioGroup value="name" onValueChange={onValueChange}>
            <ContextMenuRadioItem value="name">By name</ContextMenuRadioItem>
            <ContextMenuRadioItem value="date">By date</ContextMenuRadioItem>
          </ContextMenuRadioGroup>
        </ContextMenuContent>
      </ContextMenu>
    )

    openMenu("Region")
    expect(await screen.findByRole("menuitemradio", { name: "By name" })).toHaveAttribute(
      "data-state",
      "checked"
    )
    await user.click(screen.getByRole("menuitemradio", { name: "By date" }))
    expect(onValueChange).toHaveBeenCalledWith("date")
  })

  it("renders label, separator, group and shortcut", async () => {
    render(
      <ContextMenu>
        <ContextMenuTrigger>Region</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuLabel inset>Actions</ContextMenuLabel>
          <ContextMenuSeparator />
          <ContextMenuGroup>
            <ContextMenuItem>
              Paste
              <ContextMenuShortcut>Ctrl+V</ContextMenuShortcut>
            </ContextMenuItem>
          </ContextMenuGroup>
        </ContextMenuContent>
      </ContextMenu>
    )

    openMenu("Region")
    expect(await screen.findByText("Actions")).toHaveAttribute("data-inset", "true")
    expect(screen.getByRole("separator")).toHaveAttribute("data-slot", "context-menu-separator")
    expect(screen.getByRole("group")).toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: "Paste Ctrl+V" })).toBeInTheDocument()
    expect(screen.getByText("Ctrl+V")).toHaveAttribute("data-slot", "context-menu-shortcut")
  })

  it("opens a submenu from its sub-trigger", async () => {
    const user = userEvent.setup()
    render(
      <ContextMenu>
        <ContextMenuTrigger>Region</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuSub>
            <ContextMenuSubTrigger inset>More</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuItem>Nested</ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
        </ContextMenuContent>
      </ContextMenu>
    )

    openMenu("Region")
    const subTrigger = await screen.findByRole("menuitem", { name: "More" })
    expect(subTrigger).toHaveAttribute("data-inset", "true")
    expect(screen.queryByRole("menuitem", { name: "Nested" })).not.toBeInTheDocument()

    await user.click(subTrigger)
    expect(await screen.findByRole("menuitem", { name: "Nested" })).toBeInTheDocument()
  })

  it("renders through an explicit ContextMenuPortal", async () => {
    render(
      <ContextMenu>
        <ContextMenuTrigger>Region</ContextMenuTrigger>
        <ContextMenuPortal>
          <ContextMenuContent>
            <ContextMenuItem>Copy</ContextMenuItem>
          </ContextMenuContent>
        </ContextMenuPortal>
      </ContextMenu>
    )

    openMenu("Region")
    // The explicit portal is exported for the second-boundary case; nesting it
    // around Content (which portals on its own) must stay a no-op.
    expect(await screen.findByRole("menuitem", { name: "Copy" })).toBeInTheDocument()
    expect(screen.getAllByRole("menu")).toHaveLength(1)
  })

  it("merges caller classes onto the content instead of dropping them", async () => {
    render(
      <ContextMenu>
        <ContextMenuTrigger>Region</ContextMenuTrigger>
        <ContextMenuContent className="p-4">
          <ContextMenuItem>Copy</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    )

    openMenu("Region")
    const menu = await screen.findByRole("menu")
    expect(menu).toHaveAttribute("data-slot", "context-menu-content")
    // cn() resolved p-1 vs p-4 rather than emitting both.
    expect(menu.className).toContain("p-4")
    expect(menu.className).not.toContain("p-1")
  })
})
