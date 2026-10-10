/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { LibraryFolder } from "@/lib/db/files-library-types"
import type { FilesEntry } from "@/lib/files-library/types"
import { useFilesLibraryStore } from "@/stores/files-library"
import { FilesBackendProvider } from "@/hooks/files-library/files-backend"
import { createLocalFilesOps, LOCAL_FILES_CAPABILITIES } from "@/lib/files-library/ops"
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

it("grows every row and control to a touch target in the phone's place sheet", () => {
  const actions = { preview: jest.fn(), setFolderStyle: jest.fn() }
  const { rerender } = render(
    <FilesSidebar
      folders={folders}
      recents={[entry("artifact:a", "Plan")]}
      trashCount={1}
      actions={actions}
      touch
    />
  )
  for (const id of [
    "files-place-all",
    "files-place-group-images",
    "files-place-folders",
    "files-place-trash",
    "files-recent-artifact:a",
    "files-recents-more",
  ]) {
    expect(screen.getByTestId(id)).toHaveClass("h-11")
  }
  expect(screen.getByTestId("files-sidebar-new-folder")).toHaveClass("size-10")
  expect(screen.getByTestId("files-tree-folder-lbf_a")).toHaveClass("h-11")

  rerender(
    <FilesSidebar
      folders={folders}
      recents={[entry("artifact:a", "Plan")]}
      trashCount={1}
      actions={actions}
    />
  )
  expect(screen.getByTestId("files-place-all")).toHaveClass("h-8")
  expect(screen.getByTestId("files-tree-folder-lbf_a")).toHaveClass("h-8")
})

describe("the Workspace files group (ADR-0223 §8)", () => {
  it("is shown inert where this device lists none, saying where they are (dormancy, rule 7)", async () => {
    renderSidebar()
    const group = screen.getByTestId("files-place-group-workspace")
    expect(group).toHaveAttribute("aria-disabled", "true")
    expect(group).toHaveAttribute("data-held-back", "no-fs-backend")
    expect(group).toHaveTextContent("Workspace files")
    expect(group).toHaveTextContent("Desktop app")
    expect(group.getAttribute("title")).toMatch(/desktop app/i)
    await userEvent.setup().click(group)
    expect(useFilesLibraryStore.getState().section).toEqual({ kind: "all" })
  })

  it("is a place like the others where the library lists them", async () => {
    const ops = { ...createLocalFilesOps(), capabilities: LOCAL_FILES_CAPABILITIES }
    render(
      <FilesBackendProvider
        backend={{
          source: { entries: [], imagesTruncated: false, loadMoreImages: jest.fn(), folders: [] },
          ops,
        }}
      >
        <FilesSidebar
          folders={folders}
          recents={[]}
          trashCount={0}
          actions={{ preview: jest.fn(), setFolderStyle: jest.fn() }}
        />
      </FilesBackendProvider>
    )
    const group = screen.getByTestId("files-place-group-workspace")
    expect(group).not.toHaveAttribute("data-held-back")
    await userEvent.setup().click(group)
    expect(useFilesLibraryStore.getState().section).toEqual({ kind: "group", group: "workspace" })
  })
})
