/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { useFilesLibraryStore } from "@/stores/files-library"
import { FilesToolbar } from "./files-toolbar"

beforeEach(() =>
  useFilesLibraryStore.setState({
    search: "",
    type: "all",
    sort: "recent",
    projectScope: "current",
    viewMode: "grid",
  })
)

it("writes search text and layout to the store", async () => {
  render(<FilesToolbar />)
  fireEvent.change(screen.getByRole("searchbox", { name: "Search files by name or content" }), {
    target: { value: "pratt" },
  })
  expect(useFilesLibraryStore.getState().search).toBe("pratt")
  await userEvent.setup().click(screen.getByRole("radio", { name: "List" }))
  expect(useFilesLibraryStore.getState().viewMode).toBe("list")
})

it("shows the current type, sort and workspace scope", () => {
  useFilesLibraryStore.setState({ type: "image", sort: "size", projectScope: "all" })
  render(<FilesToolbar />)
  expect(screen.getByRole("combobox", { name: "Type" })).toHaveTextContent("Images")
  expect(screen.getByRole("combobox", { name: "Sort" })).toHaveTextContent("Size")
  expect(screen.getByRole("combobox", { name: "Workspace" })).toHaveTextContent("All workspaces")
})
