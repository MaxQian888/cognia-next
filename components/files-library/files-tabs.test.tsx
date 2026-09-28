/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { useFilesLibraryStore } from "@/stores/files-library"
import { FilesTabs } from "./files-tabs"

beforeEach(() =>
  useFilesLibraryStore.setState({ tab: "recent", folderId: "lbf_x", selectedKey: "k" })
)

it("lists the five views and switches tab, resetting folder and preview", async () => {
  render(<FilesTabs />)
  expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
    "Recent",
    "Favorites",
    "Folders",
    "Images",
    "All",
  ])
  await userEvent.setup().click(screen.getByRole("tab", { name: "Images" }))
  expect(useFilesLibraryStore.getState()).toMatchObject({
    tab: "images",
    folderId: "root",
    selectedKey: null,
  })
})
