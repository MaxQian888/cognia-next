/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { LibraryFolder } from "@/lib/db/files-library-types"
import { useFilesLibraryStore } from "@/stores/files-library"
import { useFilesFolderMenu } from "./files-folder-menu"
import { FilesMenuNodes } from "./files-menu"

const folder: LibraryFolder = {
  id: "lbf_a",
  name: "Specs",
  parentFolderId: "root",
  createdAt: 1,
  updatedAt: 1,
  color: "blue",
}

function Menu({ setFolderStyle }: { setFolderStyle: jest.Mock }) {
  const nodes = useFilesFolderMenu(folder, { setFolderStyle })
  return (
    <DropdownMenu>
      <DropdownMenuTrigger>open</DropdownMenuTrigger>
      <DropdownMenuContent>
        <FilesMenuNodes nodes={nodes} kind="dropdown" testIdPrefix="f" />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

beforeEach(() =>
  useFilesLibraryStore.setState({
    folderDialog: null,
    deleteFolderTarget: null,
    expandedFolderIds: [],
  })
)

async function open() {
  const user = userEvent.setup()
  await user.click(screen.getByRole("button", { name: "open" }))
  return user
}

it("creates a subfolder inside it, opening it in the tree", async () => {
  render(<Menu setFolderStyle={jest.fn()} />)
  const user = await open()
  await user.click(screen.getByRole("menuitem", { name: "New subfolder" }))
  expect(useFilesLibraryStore.getState()).toMatchObject({
    folderDialog: { mode: "create", parentId: "lbf_a" },
    expandedFolderIds: ["lbf_a"],
  })
})

it("renames and asks before deleting", async () => {
  render(<Menu setFolderStyle={jest.fn()} />)
  let user = await open()
  await user.click(screen.getByRole("menuitem", { name: "Rename folder" }))
  expect(useFilesLibraryStore.getState().folderDialog).toEqual({
    mode: "rename",
    folderId: "lbf_a",
    name: "Specs",
  })
  user = await open()
  await user.click(screen.getByRole("menuitem", { name: "Delete folder" }))
  expect(useFilesLibraryStore.getState().deleteFolderTarget).toBe("lbf_a")
})

it("picks a color (marking the current one) and an icon", async () => {
  const setFolderStyle = jest.fn()
  render(<Menu setFolderStyle={setFolderStyle} />)
  let user = await open()
  await user.click(screen.getByRole("menuitem", { name: "Color" }))
  expect(await screen.findByTestId("f-color-blue")).toHaveAttribute("aria-current", "true")
  fireEvent.click(screen.getByTestId("f-color-red"))
  expect(setFolderStyle).toHaveBeenCalledWith("lbf_a", { color: "red" })

  user = await open()
  await user.click(screen.getByRole("menuitem", { name: "Color" }))
  fireEvent.click(await screen.findByTestId("f-color-default"))
  expect(setFolderStyle).toHaveBeenLastCalledWith("lbf_a", { color: null })

  user = await open()
  await user.click(screen.getByRole("menuitem", { name: "Icon" }))
  expect(await screen.findByTestId("f-icon-folder")).toHaveAttribute("aria-current", "true")
  fireEvent.click(screen.getByTestId("f-icon-star"))
  expect(setFolderStyle).toHaveBeenLastCalledWith("lbf_a", { icon: "star" })

  user = await open()
  await user.click(screen.getByRole("menuitem", { name: "Icon" }))
  fireEvent.click(await screen.findByTestId("f-icon-folder"))
  expect(setFolderStyle).toHaveBeenLastCalledWith("lbf_a", { icon: null })
})
