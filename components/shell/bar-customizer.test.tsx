/**
 * @jest-environment jsdom
 */

import { act, fireEvent, render, screen } from "@testing-library/react"

import { BarCustomizer } from "./bar-customizer"
import { TooltipProvider } from "@/components/ui/tooltip"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { DEFAULT_BAR_ITEMS, useUIStore } from "@/stores/ui/ui-store"
import {
  DEFAULT_STATUS_BAR_LAYOUT,
  DEFAULT_TITLE_BAR_LAYOUT,
  type BarLayout,
} from "@/types/shell/bars"

jest.mock("next-intl", () => ({
  // Return the leaf key so assertions target stable strings; item labels come
  // back as `items.<id>` and zone badges as `zones.<zone>`.
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/hooks/use-platform", () => ({ usePlatform: () => "tauri" }))

// jsdom has no layout, so dnd-kit's collision detection never resolves an
// `over` target and a real keyboard/pointer drag ends as a no-op. Capture the
// `onDragEnd` the shared list installs so the reorder path can be driven with a
// synthetic drop.
let lastDragEnd: ((event: unknown) => void) | undefined
jest.mock("@dnd-kit/core", () => {
  const actual = jest.requireActual<typeof import("@dnd-kit/core")>("@dnd-kit/core")
  return {
    ...actual,
    DndContext: ({
      children,
      onDragEnd,
    }: {
      children: React.ReactNode
      onDragEnd: (event: unknown) => void
    }) => {
      lastDragEnd = onDragEnd
      return <>{children}</>
    },
  }
})

const saveMock = jest.fn(
  async (_patch?: { titleBarLayout?: BarLayout; statusBarLayout?: BarLayout }) => {}
)

function setLayout(key: "titleBarLayout" | "statusBarLayout", layout: BarLayout) {
  useSettingsStore.setState({ settings: { [key]: layout } as never, save: saveMock as never })
}

beforeEach(() => {
  saveMock.mockClear()
  useUIStore.setState({ barItems: { ...DEFAULT_BAR_ITEMS } })
  useSettingsStore.setState({ settings: {} as never, save: saveMock as never })
})

const renderCustomizer = (bar: "title" | "status") =>
  render(
    <TooltipProvider>
      <BarCustomizer bar={bar} />
    </TooltipProvider>
  )

const lastSaved = (key: "titleBarLayout" | "statusBarLayout"): BarLayout =>
  saveMock.mock.calls[saveMock.mock.calls.length - 1]?.[0]?.[key] as BarLayout

describe("BarCustomizer", () => {
  it("splits the status bar into in-bar and hidden rows", () => {
    renderCustomizer("status")
    // Visible segments are drag-sortable rows.
    expect(screen.getByTestId("bar-customizer-status-list-pinned-connectivity")).toBeInTheDocument()
    // `perf` ships hidden.
    expect(screen.getByTestId("bar-customizer-status-list-row-perf")).toBeInTheDocument()
  })

  it("has no More bucket — a bar segment is in it or not", () => {
    renderCustomizer("status")
    expect(screen.queryByText("moreEmpty")).toBeNull()
    // …and therefore no per-row "move to More" action.
    expect(screen.queryByTestId("bar-customizer-status-list-unpin-connectivity")).toBeNull()
    expect(screen.queryByTestId("bar-customizer-status-list-pin-perf")).toBeNull()
  })

  it("labels every row with its structural zone", () => {
    renderCustomizer("status")
    expect(screen.getByTestId("customizer-hint-connectivity")).toHaveTextContent("zones.start")
    expect(screen.getByTestId("customizer-hint-runStatus")).toHaveTextContent("zones.end")
  })

  it("removes a segment from the bar, keeping its slot in the order", () => {
    renderCustomizer("status")
    fireEvent.click(screen.getByTestId("bar-customizer-status-list-hide-branch"))
    const saved = lastSaved("statusBarLayout")
    expect(saved.hidden).toContain("branch")
    expect(saved.order).toEqual(DEFAULT_STATUS_BAR_LAYOUT.order)
  })

  it("adds a hidden segment back", () => {
    renderCustomizer("status")
    fireEvent.click(screen.getByTestId("bar-customizer-status-list-show-perf"))
    expect(lastSaved("statusBarLayout").hidden).toEqual([])
  })

  it("keeps the title bar and the status bar on separate settings keys", () => {
    renderCustomizer("title")
    fireEvent.click(screen.getByTestId("bar-customizer-title-list-hide-search"))
    expect(saveMock.mock.calls.at(-1)?.[0]).toHaveProperty("titleBarLayout")
    expect(saveMock.mock.calls.at(-1)?.[0]).not.toHaveProperty("statusBarLayout")
  })

  it("disables Restore defaults at the shipped layout and enables it after an edit", () => {
    const { rerender } = renderCustomizer("status")
    expect(screen.getByTestId("bar-customizer-status-list-reset")).toBeDisabled()

    act(() => setLayout("statusBarLayout", { order: DEFAULT_STATUS_BAR_LAYOUT.order, hidden: [] }))
    rerender(
      <TooltipProvider>
        <BarCustomizer bar="status" />
      </TooltipProvider>
    )
    expect(screen.getByTestId("bar-customizer-status-list-reset")).not.toBeDisabled()
  })

  it("restores this bar's defaults on click", () => {
    setLayout("titleBarLayout", { order: ["search"], hidden: ["appIcon"] })
    renderCustomizer("title")
    fireEvent.click(screen.getByTestId("bar-customizer-title-list-reset"))
    expect(lastSaved("titleBarLayout")).toEqual(DEFAULT_TITLE_BAR_LAYOUT)
  })

  it("renders the empty state when every segment is hidden", () => {
    setLayout("statusBarLayout", {
      order: DEFAULT_STATUS_BAR_LAYOUT.order,
      hidden: [...DEFAULT_STATUS_BAR_LAYOUT.order],
    })
    renderCustomizer("status")
    expect(screen.getByText("inBarEmpty")).toBeInTheDocument()
  })

  it("renders the hidden empty state when nothing is hidden", () => {
    setLayout("statusBarLayout", { order: DEFAULT_STATUS_BAR_LAYOUT.order, hidden: [] })
    renderCustomizer("status")
    expect(screen.getByText("hiddenEmpty")).toBeInTheDocument()
  })

  it("starts a keyboard drag from the grip handle without throwing", () => {
    renderCustomizer("status")
    const handle = screen.getByTestId("bar-customizer-status-list-handle-connectivity")
    act(() => {
      fireEvent.keyDown(handle, { code: "Space" })
      fireEvent.keyDown(handle, { code: "ArrowDown" })
      fireEvent.keyDown(handle, { code: "Space" })
    })
    expect(screen.getByTestId("bar-customizer-status-list-pinned-connectivity")).toBeInTheDocument()
  })

  it("persists a drop as a reorder of the full stored order", () => {
    renderCustomizer("status")
    act(() => {
      lastDragEnd?.({ active: { id: "sync" }, over: { id: "connectivity" } })
    })
    const saved = lastSaved("statusBarLayout")
    // `sync` moved to the head of the visible list…
    expect(saved.order.slice(0, 3)).toEqual(["sync", "connectivity", "branch"])
    // …and the hidden `perf` kept the slot it already held.
    expect(saved.order.indexOf("perf")).toBe(DEFAULT_STATUS_BAR_LAYOUT.order.indexOf("perf"))
    expect(saved.hidden).toEqual(["perf"])
  })

  it("ignores a drop that lands on nothing", () => {
    renderCustomizer("status")
    act(() => {
      lastDragEnd?.({ active: { id: "sync" }, over: null })
    })
    expect(saveMock).not.toHaveBeenCalled()
  })
})
