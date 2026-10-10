/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { DEFAULT_FILES_VIEW_FILTERS, useFilesLibraryStore } from "@/stores/files-library"
import { FilesFilterPopover } from "./files-filter-popover"

beforeEach(() =>
  useFilesLibraryStore.setState({
    search: "",
    filters: DEFAULT_FILES_VIEW_FILTERS,
    projectScope: "current",
  })
)

it("toggles formats and picks a modified range and a size band", async () => {
  const user = userEvent.setup()
  render(<FilesFilterPopover />)
  await user.click(screen.getByRole("button", { name: "Filter" }))
  await user.click(screen.getByRole("checkbox", { name: "Code" }))
  await user.click(screen.getByRole("checkbox", { name: "Image" }))
  expect(useFilesLibraryStore.getState().filters.formats).toEqual(["code", "image"])
  await user.click(screen.getByRole("checkbox", { name: "Code" }))
  expect(useFilesLibraryStore.getState().filters.formats).toEqual(["image"])

  await user.click(screen.getByRole("radio", { name: "Past week" }))
  await user.click(screen.getByRole("radio", { name: "1–10 MB" }))
  expect(useFilesLibraryStore.getState().filters).toMatchObject({
    modified: "week",
    size: "medium",
  })
})

it("counts active filters on the trigger and resets them", async () => {
  useFilesLibraryStore.setState({
    filters: { formats: ["code"], modified: "day", size: "any" },
    search: "x",
  })
  const user = userEvent.setup()
  render(<FilesFilterPopover />)
  const trigger = screen.getByRole("button", { name: "Filter, 2 active" })
  await user.click(trigger)
  await user.click(screen.getByRole("button", { name: "Reset" }))
  expect(useFilesLibraryStore.getState().filters).toEqual(DEFAULT_FILES_VIEW_FILTERS)
  expect(useFilesLibraryStore.getState().search).toBe("")
})

it("switches the workspace scope without counting it as a filter", async () => {
  const user = userEvent.setup()
  render(<FilesFilterPopover />)
  await user.click(screen.getByRole("button", { name: "Filter" }))
  await user.click(screen.getByRole("radio", { name: "All workspaces" }))
  expect(useFilesLibraryStore.getState().projectScope).toBe("all")
  expect(screen.getByRole("button", { name: "Reset" })).toBeDisabled()
})
