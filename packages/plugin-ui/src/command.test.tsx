import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import * as commandModule from "./command"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "./command"

function renderPalette(onSelect = jest.fn()) {
  render(
    <Command label="Plugin actions">
      <CommandInput placeholder="Search actions" />
      <CommandList>
        <CommandEmpty>No matching action</CommandEmpty>
        <CommandGroup heading="Repository">
          <CommandItem value="clone" onSelect={onSelect}>
            Clone repository
            <CommandShortcut>⌘C</CommandShortcut>
          </CommandItem>
          <CommandItem value="pull" onSelect={onSelect}>
            Pull latest
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Danger">
          <CommandItem value="reset" disabled onSelect={onSelect}>
            Hard reset
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </Command>
  )
  return onSelect
}

describe("Command", () => {
  it("exposes the palette through combobox / listbox / option roles", () => {
    renderPalette()

    expect(screen.getByRole("combobox")).toHaveAttribute("data-slot", "command-input")
    expect(screen.getByRole("listbox")).toHaveAttribute("data-slot", "command-list")
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Clone repository⌘C",
      "Pull latest",
      "Hard reset",
    ])
    // cmdk splits a group into an outer wrapper (which carries our data-slot
    // and the heading) and an inner role="group" holding the items, so the slot
    // is on the ancestor rather than on the labelled element itself.
    expect(
      screen.getByRole("group", { name: "Repository" }).closest("[data-slot=command-group]")
    ).not.toBeNull()
    expect(screen.getByRole("separator")).toHaveAttribute("data-slot", "command-separator")
  })

  it("filters the list as the caller types", async () => {
    const user = userEvent.setup()
    renderPalette()

    await user.type(screen.getByRole("combobox"), "pull")

    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Pull latest"])
    // A group with no surviving items is dropped along with its heading.
    expect(screen.queryByRole("group", { name: "Danger" })).not.toBeInTheDocument()
  })

  it("shows the caller's empty copy only once nothing matches", async () => {
    const user = userEvent.setup()
    renderPalette()

    expect(screen.queryByText("No matching action")).not.toBeInTheDocument()

    await user.type(screen.getByRole("combobox"), "zzzz")

    const empty = await screen.findByText("No matching action")
    expect(empty).toHaveAttribute("data-slot", "command-empty")
    expect(screen.queryAllByRole("option")).toHaveLength(0)
  })

  it("reports the chosen value through onSelect", async () => {
    const user = userEvent.setup()
    const onSelect = renderPalette()

    await user.click(screen.getByRole("option", { name: /Clone repository/ }))

    expect(onSelect).toHaveBeenCalledWith("clone")
  })

  it("does not select a disabled item", async () => {
    const user = userEvent.setup()
    const onSelect = renderPalette()

    const disabled = screen.getByRole("option", { name: "Hard reset" })
    expect(disabled).toHaveAttribute("data-disabled", "true")
    await user.click(disabled)

    expect(onSelect).not.toHaveBeenCalled()
  })

  it("moves the cmdk highlight with the arrow keys while focus stays in the input", async () => {
    const user = userEvent.setup()
    renderPalette()

    const input = screen.getByRole("combobox")
    await user.click(input)
    await user.keyboard("{ArrowDown}")

    // cmdk drives the highlight with data-selected — the active row is never
    // the focused element, which is why the styles key off that attribute.
    expect(screen.getByRole("option", { name: "Pull latest" })).toHaveAttribute(
      "data-selected",
      "true"
    )
    expect(input).toHaveFocus()
  })

  it("merges caller classes rather than appending a conflicting utility", () => {
    render(
      <Command className="rounded-none">
        <CommandList className="max-h-40">
          <CommandItem value="a">A</CommandItem>
        </CommandList>
      </Command>
    )

    const list = screen.getByRole("listbox")
    expect(list.className).toContain("max-h-40")
    // cn() resolved max-h-[300px] vs max-h-40 instead of emitting both.
    expect(list.className).not.toContain("max-h-[300px]")
  })

  /**
   * The host's `components/ui/command.tsx` also exports a `CommandDialog`
   * wrapper. It is deliberately NOT ported: plugin-ui has no Dialog, and
   * centered modals are the runtime's job via `ctx.modal.openModal()`. Pinned
   * here so a future "port the rest of the file" pass has to read the reason.
   */
  it("intentionally ships no CommandDialog", () => {
    expect(commandModule).not.toHaveProperty("CommandDialog")
  })
})
