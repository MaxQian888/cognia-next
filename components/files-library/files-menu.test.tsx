/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { PencilIcon } from "lucide-react"

import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { FilesMenuNodes, type FilesMenuNode } from "./files-menu"

function model(onRename: () => void, onRed: () => void): FilesMenuNode[] {
  return [
    {
      type: "item",
      id: "rename",
      label: "Rename",
      icon: PencilIcon,
      hint: "F2",
      onSelect: onRename,
    },
    { type: "item", id: "share", label: "Share", disabled: true, onSelect: jest.fn() },
    { type: "separator", id: "sep" },
    {
      type: "submenu",
      id: "color",
      label: "Color",
      children: [
        { type: "item", id: "red", label: "Red", current: true, onSelect: onRed },
        { type: "item", id: "trash", label: "Delete", destructive: true, onSelect: jest.fn() },
      ],
    },
  ]
}

it("renders one model as a dropdown with hints, disabled items and submenus", async () => {
  const onRename = jest.fn()
  const onRed = jest.fn()
  const user = userEvent.setup()
  render(
    <DropdownMenu>
      <DropdownMenuTrigger>open</DropdownMenuTrigger>
      <DropdownMenuContent>
        <FilesMenuNodes nodes={model(onRename, onRed)} kind="dropdown" testIdPrefix="m" />
      </DropdownMenuContent>
    </DropdownMenu>
  )
  await user.click(screen.getByRole("button", { name: "open" }))
  expect(screen.getByTestId("m-rename")).toHaveTextContent("RenameF2")
  expect(screen.getByTestId("m-share")).toHaveAttribute("aria-disabled", "true")
  expect(screen.getByRole("separator")).toBeInTheDocument()
  await user.click(screen.getByTestId("m-rename"))
  expect(onRename).toHaveBeenCalled()

  await user.click(screen.getByRole("button", { name: "open" }))
  await user.click(screen.getByTestId("m-color"))
  const red = await screen.findByTestId("m-red")
  expect(red).toHaveAttribute("aria-current", "true")
  expect(screen.getByTestId("m-trash")).toHaveAttribute("data-variant", "destructive")
  // A pointer leaving the sub-trigger closes the submenu in jsdom; click directly.
  fireEvent.click(red)
  expect(onRed).toHaveBeenCalled()
})

it("renders the same model as a context menu", async () => {
  const onRename = jest.fn()
  render(
    <ContextMenu>
      <ContextMenuTrigger>
        <div data-testid="target">target</div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <FilesMenuNodes nodes={model(onRename, jest.fn())} kind="context" testIdPrefix="c" />
      </ContextMenuContent>
    </ContextMenu>
  )
  fireEvent.contextMenu(screen.getByTestId("target"))
  await userEvent.setup().click(await screen.findByTestId("c-rename"))
  expect(onRename).toHaveBeenCalled()
})
