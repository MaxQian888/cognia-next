/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { useFilesLibraryStore } from "@/stores/files-library"
import { FilesLensTabs } from "./files-lens-tabs"

beforeEach(() => useFilesLibraryStore.setState({ section: { kind: "all" }, lens: "suggested" }))

it("lists every lens and switches between them", async () => {
  const user = userEvent.setup()
  render(<FilesLensTabs />)
  for (const name of ["Suggested", "Favorites", "Mine", "AI-generated", "Shared with me"]) {
    expect(screen.getByRole("tab", { name })).toBeInTheDocument()
  }
  expect(screen.getByRole("tab", { name: "Suggested" })).toHaveAttribute("aria-selected", "true")
  await user.click(screen.getByRole("tab", { name: "AI-generated" }))
  expect(useFilesLibraryStore.getState().lens).toBe("ai")
})

it("shows no lenses in the Trash", () => {
  useFilesLibraryStore.setState({ section: { kind: "trash" } })
  render(<FilesLensTabs />)
  expect(screen.queryByRole("tablist")).toBeNull()
})
