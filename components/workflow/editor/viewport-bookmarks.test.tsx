/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TooltipProvider } from "@/components/ui/tooltip"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { listBookmarks, saveBookmark } from "@/lib/workflow/editor/viewport-bookmarks-db"
import { ViewportBookmarks } from "./viewport-bookmarks"

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

function renderBookmarks(overrides: Partial<React.ComponentProps<typeof ViewportBookmarks>> = {}) {
  const onRestore = jest.fn()
  const utils = render(
    <TooltipProvider>
      <ViewportBookmarks
        workflowId="wf_a"
        currentViewport={{ x: 0, y: 0, zoom: 1.25 }}
        onRestore={overrides.onRestore ?? onRestore}
        {...overrides}
      />
    </TooltipProvider>
  )
  return { ...utils, onRestore }
}

describe("ViewportBookmarks", () => {
  it("opens the save dialog with the current zoom as the default name", async () => {
    renderBookmarks()
    const user = userEvent.setup()
    await user.click(screen.getByTestId("viewport-bookmarks-trigger"))
    fireEvent.click(screen.getByTestId("viewport-bookmarks-save"))
    const input = await screen.findByTestId("viewport-bookmark-name-input")
    expect((input as HTMLInputElement).value).toContain("125")
  })

  it("persists a new bookmark via saveBookmark", async () => {
    renderBookmarks()
    const user = userEvent.setup()
    await user.click(screen.getByTestId("viewport-bookmarks-trigger"))
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
    const user = userEvent.setup()
    await user.click(screen.getByTestId("viewport-bookmarks-trigger"))
    // Wait for the liveQuery to hydrate.
    const row = await screen.findByText("v1")
    fireEvent.click(row.closest('[role="menuitem"]') as Element)
    expect(onRestore).toHaveBeenCalledWith({ x: 10, y: 20, zoom: 0.5 })
  })

  it("shows the empty state when no bookmarks exist", async () => {
    renderBookmarks()
    const user = userEvent.setup()
    await user.click(screen.getByTestId("viewport-bookmarks-trigger"))
    expect(await screen.findByText("No saved views yet.")).toBeInTheDocument()
  })

  it("fires a success toast after saving a bookmark", async () => {
    renderBookmarks()
    const user = userEvent.setup()
    await user.click(screen.getByTestId("viewport-bookmarks-trigger"))
    fireEvent.click(screen.getByTestId("viewport-bookmarks-save"))
    const input = await screen.findByTestId("viewport-bookmark-name-input")
    fireEvent.change(input, { target: { value: "v1" } })
    fireEvent.click(screen.getByTestId("viewport-bookmark-confirm"))
    await waitFor(() => {
      expect(mockToastSuccess).toHaveBeenCalledWith("View saved")
    })
  })
})
