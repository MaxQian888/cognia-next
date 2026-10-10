/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { LibraryFolder } from "@/lib/db/files-library-types"
import { useFilesLibraryStore } from "@/stores/files-library"
import { FilesBreadcrumb, placeTitle } from "./files-breadcrumb"

function folder(id: string, name: string, parentFolderId = "root"): LibraryFolder {
  return { id, name, parentFolderId, createdAt: 1, updatedAt: 1 }
}
const folders = [folder("a", "Specs"), folder("b", "Drafts", "a")]
const t = (key: string) => `t:${key}`

describe("placeTitle", () => {
  it("names each kind of place", () => {
    expect(placeTitle({ kind: "all" }, folders, t)).toBe("t:places.all")
    expect(placeTitle({ kind: "group", group: "videos" }, folders, t)).toBe(
      "t:places.groups.videos"
    )
    expect(placeTitle({ kind: "recent" }, folders, t)).toBe("t:places.recents")
    expect(placeTitle({ kind: "trash" }, folders, t)).toBe("t:places.trash")
    expect(placeTitle({ kind: "folder", folderId: "root" }, folders, t)).toBe("t:folders.root")
    expect(placeTitle({ kind: "folder", folderId: "b" }, folders, t)).toBe("Drafts")
    expect(placeTitle({ kind: "folder", folderId: "gone" }, folders, t)).toBe("t:folders.root")
  })
})

it("renders only inside a folder", () => {
  useFilesLibraryStore.setState({ section: { kind: "all" } })
  render(<FilesBreadcrumb folders={folders} actions={{ setFolderStyle: jest.fn() }} />)
  expect(screen.queryByRole("navigation")).toBeNull()
})

it("walks back up the path and offers the current folder's menu", async () => {
  useFilesLibraryStore.setState({ section: { kind: "folder", folderId: "b" }, folderDialog: null })
  render(<FilesBreadcrumb folders={folders} actions={{ setFolderStyle: jest.fn() }} />)
  const nav = screen.getByRole("navigation", { name: "Folder path" })
  expect(nav).toHaveTextContent("All foldersSpecsDrafts")
  expect(screen.getByTestId("files-breadcrumb-b")).toHaveAttribute("aria-current", "page")
  const user = userEvent.setup()
  await user.click(screen.getByRole("button", { name: "Folder actions for Drafts" }))
  await user.click(screen.getByRole("menuitem", { name: "Rename folder" }))
  expect(useFilesLibraryStore.getState().folderDialog).toMatchObject({ folderId: "b" })
  await user.click(screen.getByTestId("files-breadcrumb-a"))
  expect(useFilesLibraryStore.getState().section).toEqual({ kind: "folder", folderId: "a" })
  await user.click(screen.getByTestId("files-breadcrumb-root"))
  expect(useFilesLibraryStore.getState().section).toEqual({ kind: "folder", folderId: "root" })
})
