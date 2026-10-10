/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { DEFAULT_FILES_VIEW_FILTERS, useFilesLibraryStore } from "@/stores/files-library"
import { FilesToolbar } from "./files-toolbar"

beforeEach(() =>
  useFilesLibraryStore.setState({
    search: "",
    filters: DEFAULT_FILES_VIEW_FILTERS,
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

it("carries the filter button", () => {
  render(<FilesToolbar />)
  expect(screen.getByTestId("files-filter")).toBeInTheDocument()
})
