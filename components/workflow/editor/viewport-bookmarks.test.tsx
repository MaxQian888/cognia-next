/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { listBookmarks, saveBookmark } from "@/lib/workflow/editor/viewport-bookmarks-db"
import { ViewportBookmarksContent } from "./viewport-bookmarks"

const mockToastSuccess = jest.fn()
jest.mock("sonner", () => ({
  __esModule: true,
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
  },
}))

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  mockToastSuccess.mockClear()
})

function renderBookmarks(
  overrides: Partial<React.ComponentProps<typeof ViewportBookmarksContent>> = {}
) {
  const onRestore = jest.fn()
  const utils = render(
    <ViewportBookmarksContent
      workflowId="wf_a"
      currentViewport={{ x: 0, y: 0, zoom: 1.25 }}
      onRestore={overrides.onRestore ?? onRestore}
      {...overrides}
    />
  )
  return { ...utils, onRestore }
}

describe("ViewportBookmarksContent", () => {
  it("opens the save dialog with the current zoom as the default name", async () => {
    renderBookmarks()
    fireEvent.click(screen.getByTestId("viewport-bookmarks-save"))
    const input = await screen.findByTestId("viewport-bookmark-name-input")
    expect((input as HTMLInputElement).value).toContain("125")
  })

  it("persists a new bookmark via saveBookmark", async () => {
    renderBookmarks()
    fireEvent.click(screen.getByTestId("viewport-bookmarks-save"))
    const input = await screen.findByTestId("viewport-bookmark-name-input")
    fireEvent.change(input, { target: { value: "Onboarding subgraph" } })
    fireEvent.click(screen.getByTestId("viewport-bookmark-confirm"))
    await waitFor(async () => {
      const rows = await listBookmarks("wf_a")
      expect(rows.map((r) => r.name)).toContain("Onboarding subgraph")
    })
  })

  it("clicking a bookmark row fires onRestore with its viewport", async () => {
    await saveBookmark("wf_a", "v1", { x: 10, y: 20, zoom: 0.5 })
    const { onRestore } = renderBookmarks()
    const row = await screen.findByText("v1")
    fireEvent.click(row.closest("button") as Element)
    expect(onRestore).toHaveBeenCalledWith({ x: 10, y: 20, zoom: 0.5 })
  })

  it("saves the bookmark when Enter is pressed in the name field", async () => {
    renderBookmarks()
    fireEvent.click(screen.getByTestId("viewport-bookmarks-save"))
    const input = await screen.findByTestId("viewport-bookmark-name-input")
    fireEvent.change(input, { target: { value: "Quick save" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(async () => {
      const rows = await listBookmarks("wf_a")
      expect(rows.map((r) => r.name)).toContain("Quick save")
    })
  })

  it("closes the save dialog when cancel is clicked", async () => {
    renderBookmarks()
    fireEvent.click(screen.getByTestId("viewport-bookmarks-save"))
    expect(await screen.findByTestId("viewport-bookmark-name-input")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("viewport-bookmark-cancel"))
    await waitFor(() => {
      expect(screen.queryByTestId("viewport-bookmark-name-input")).toBeNull()
    })
  })

  it("removes a bookmark when its delete button is clicked", async () => {
    const saved = await saveBookmark("wf_a", "v1", { x: 10, y: 20, zoom: 0.5 })
    renderBookmarks()
    const del = await screen.findByTestId(`viewport-bookmark-delete-${saved.id}`)
    fireEvent.click(del)
    await waitFor(async () => {
      const rows = await listBookmarks("wf_a")
      expect(rows).toHaveLength(0)
    })
  })

  it("shows the empty state when no bookmarks exist", async () => {
    renderBookmarks()
    expect(await screen.findByText("No saved views yet.")).toBeInTheDocument()
  })

  it("fires a success toast after saving a bookmark", async () => {
    renderBookmarks()
    fireEvent.click(screen.getByTestId("viewport-bookmarks-save"))
    const input = await screen.findByTestId("viewport-bookmark-name-input")
    fireEvent.change(input, { target: { value: "v1" } })
    fireEvent.click(screen.getByTestId("viewport-bookmark-confirm"))
    await waitFor(() => {
      expect(mockToastSuccess).toHaveBeenCalledWith("View saved")
    })
  })
})
