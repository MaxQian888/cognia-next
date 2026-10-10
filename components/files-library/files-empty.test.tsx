/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { FilesEmpty, filesEmptyCopy } from "./files-empty"

describe("filesEmptyCopy", () => {
  it("prefers the filter, then the Trash, then the lens, then the place", () => {
    expect(filesEmptyCopy({ kind: "trash" }, "ai", true)).toBe("search")
    expect(filesEmptyCopy({ kind: "trash" }, "ai", false)).toBe("trash")
    expect(filesEmptyCopy({ kind: "all" }, "favorites", false)).toBe("favorites")
    expect(filesEmptyCopy({ kind: "folder", folderId: "x" }, "suggested", false)).toBe("folder")
    expect(filesEmptyCopy({ kind: "group", group: "images" }, "suggested", false)).toBe("group")
    expect(filesEmptyCopy({ kind: "recent" }, "suggested", false)).toBe("recent")
  })
})

it("explains an empty Trash", () => {
  render(
    <FilesEmpty section={{ kind: "trash" }} lens="suggested" filtered={false} onClear={jest.fn()} />
  )
  expect(screen.getByTestId("files-empty-trash")).toHaveTextContent("The Trash is empty")
  expect(screen.queryByRole("button")).toBeNull()
})

it("offers to clear a search that hid everything", async () => {
  const onClear = jest.fn()
  render(<FilesEmpty section={{ kind: "all" }} lens="mine" filtered onClear={onClear} />)
  await userEvent.setup().click(screen.getByRole("button", { name: "Clear filters" }))
  expect(onClear).toHaveBeenCalled()
})

it("says how to fill an empty folder by tap on the phone, and by drag elsewhere", () => {
  const props = {
    section: { kind: "folder", folderId: "f1" } as const,
    lens: "suggested" as const,
    filtered: false,
    onClear: jest.fn(),
  }
  const { rerender } = render(<FilesEmpty {...props} touch />)
  expect(screen.getByTestId("files-empty-folder")).toHaveTextContent("select items and tap Move")
  rerender(<FilesEmpty {...props} />)
  expect(screen.getByTestId("files-empty-folder")).toHaveTextContent("Drag items here")
})
