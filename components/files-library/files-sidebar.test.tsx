/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { LibraryFolder } from "@/lib/db/files-library-types"
import type { FilesEntry } from "@/lib/files-library/types"
import { useFilesLibraryStore } from "@/stores/files-library"
import { FilesSidebar } from "./files-sidebar"

function entry(key: string, title: string): FilesEntry {
  return {
    key,
    kind: "artifact",
    sourceId: key,
    title,
    sourceTitle: title,
    projectIds: [],
    sessionIds: [],
    originAlive: true,
    createdAt: 1,
    updatedAt: 1,
    ownedByFiles: false,
    hidden: false,
    sharedWithMe: false,
    creator: "user",
    searchText: "",
  }
}
const folders: LibraryFolder[] = [
  { id: "lbf_a", name: "Specs", parentFolderId: "root", createdAt: 1, updatedAt: 1 },
]

beforeEach(() => useFilesLibraryStore.setState({ section: { kind: "all" }, folderDialog: null }))

function renderSidebar(recents: FilesEntry[] = [], trashCount = 0) {
  const actions = { preview: jest.fn(), setFolderStyle: jest.fn() }
  render(
    <FilesSidebar folders={folders} recents={recents} trashCount={trashCount} actions={actions} />
  )
  return actions
}

it("lists the places and marks the current one", async () => {
  renderSidebar()
  const nav = screen.getByRole("navigation", { name: "Files places" })
  for (const name of [
    "All",
    "Documents",
    "Artifacts",
    "Images",
    "Videos",
    "Uploads",
    "All folders",
    "Trash",
  ]) {
    expect(nav).toHaveTextContent(name)
  }
  expect(screen.getByTestId("files-place-all")).toHaveAttribute("aria-current", "page")
  const user = userEvent.setup()
  await user.click(screen.getByTestId("files-place-group-images"))
  expect(useFilesLibraryStore.getState().section).toEqual({ kind: "group", group: "images" })
  await user.click(screen.getByTestId("files-place-trash"))
  expect(useFilesLibraryStore.getState().section).toEqual({ kind: "trash" })
  await user.click(screen.getByTestId("files-place-folders"))
  expect(useFilesLibraryStore.getState().section).toEqual({ kind: "folder", folderId: "root" })
})

it("previews a recent item and opens the Recents place", async () => {
  const recent = entry("artifact:a", "Parser")
  const actions = renderSidebar([recent])
  const user = userEvent.setup()
  await user.click(screen.getByRole("button", { name: "Open Parser" }))
  expect(actions.preview).toHaveBeenCalledWith(recent)
  await user.click(screen.getByRole("button", { name: "Show more" }))
  expect(useFilesLibraryStore.getState().section).toEqual({ kind: "recent" })
})

it("says when nothing was opened yet and counts the Trash", () => {
  renderSidebar([], 3)
  expect(screen.getByText("Nothing opened yet")).toBeInTheDocument()
  expect(screen.getByTestId("files-place-trash")).toHaveTextContent("Trash3")
})

it("creates a top-level folder and draws the folder tree", async () => {
  renderSidebar()
  expect(screen.getByRole("tree")).toHaveTextContent("Specs")
  await userEvent.setup().click(screen.getByRole("button", { name: "New folder" }))
  expect(useFilesLibraryStore.getState().folderDialog).toEqual({ mode: "create", parentId: "root" })
})
