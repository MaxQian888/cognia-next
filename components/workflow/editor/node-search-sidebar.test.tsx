/**
 * @jest-environment jsdom
 */
import "@testing-library/jest-dom"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { TooltipProvider } from "@/components/ui/tooltip"
import { usePalettePreferencesStore } from "@/stores/workflow"
import { NodeSearchSidebar } from "./node-search-sidebar"

function mount() {
  return render(
    <NextIntlClientProvider locale="en" messages={{}} timeZone="UTC">
      <TooltipProvider>
        <NodeSearchSidebar />
      </TooltipProvider>
    </NextIntlClientProvider>
  )
}

function resetPrefs() {
  act(() => {
    usePalettePreferencesStore.setState({ favoriteNodeKinds: [], recentlyUsedNodeKinds: [] })
  })
}

describe("NodeSearchSidebar", () => {
  beforeEach(resetPrefs)

  it("renders the catalog grouped by category in browse mode", () => {
    mount()
    // Built-in trigger kind chip is present.
    expect(screen.getAllByTestId("wf-sidebar-trigger.manual").length).toBeGreaterThan(0)
  })

  it("shows the empty favorites hint until a node is starred", () => {
    mount()
    // The Favorites group renders its empty-state hint (from en.json).
    expect(screen.getByText("No favorites yet — star a node to pin it here.")).toBeInTheDocument()
  })

  it("starring a node pins it into the Favorites group", () => {
    mount()
    // One occurrence (its category) before favoriting.
    expect(screen.getAllByTestId("wf-sidebar-trigger.manual")).toHaveLength(1)

    const star = screen.getByTestId("wf-sidebar-fav-trigger.manual")
    act(() => {
      fireEvent.click(star)
    })

    expect(usePalettePreferencesStore.getState().favoriteNodeKinds).toContain("trigger.manual")
    // Now it appears twice: once in Favorites, once in its category.
    expect(screen.getAllByTestId("wf-sidebar-trigger.manual")).toHaveLength(2)
  })

  it("surfaces recently-used kinds in the Recent group", () => {
    act(() => {
      usePalettePreferencesStore.getState().recordUsed("ai.prompt")
    })
    mount()
    const recentHeader = screen.getByText("Recently used")
    expect(recentHeader).toBeInTheDocument()
    expect(screen.getAllByTestId("wf-sidebar-ai.prompt").length).toBeGreaterThanOrEqual(2)
  })

  it("hides favorites/recent and shows flat results while searching", () => {
    act(() => {
      usePalettePreferencesStore.getState().toggleFavorite("trigger.manual")
    })
    mount()
    const search = screen.getByPlaceholderText("Search nodes…")
    act(() => {
      fireEvent.change(search, { target: { value: "manual" } })
    })
    // Favorites group header is gone in search mode.
    expect(screen.queryByText("Favorites")).toBeNull()
    // The matching node still shows (flat results).
    expect(screen.getAllByTestId("wf-sidebar-trigger.manual").length).toBeGreaterThan(0)
  })

  it("ignores favorites for kinds that are not in the catalog", () => {
    act(() => {
      usePalettePreferencesStore.setState({ favoriteNodeKinds: ["plugin.ghost.kind"] })
    })
    mount()
    // Stale kind is filtered out → favorites group stays in its empty state.
    expect(screen.getByText("No favorites yet — star a node to pin it here.")).toBeInTheDocument()
  })
})
