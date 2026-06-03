/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, act } from "@testing-library/react"

import { SidebarCustomizer } from "./sidebar-customizer"
import { TooltipProvider } from "@/components/ui/tooltip"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { DEFAULT_SIDEBAR_LAYOUT, SIDEBAR_NAV_META } from "@/types/shell/sidebar"

jest.mock("next-intl", () => ({
  // Return the leaf key so assertions can target stable strings, and item
  // label keys (e.g. "workflows") render as their own id.
  useTranslations: () => (key: string) => key,
}))

const saveMock = jest.fn(
  async (_patch?: { sidebarLayout?: { pinned: string[]; hidden: string[] } }) => {}
)

function setLayout(pinned: string[], hidden: string[]) {
  useSettingsStore.setState({
    settings: { sidebarLayout: { pinned, hidden } } as never,
    save: saveMock as never,
  })
}

beforeEach(() => {
  saveMock.mockClear()
  setLayout(["workflows", "inbox"], [])
})

const renderCustomizer = () =>
  render(
    <TooltipProvider>
      <SidebarCustomizer />
    </TooltipProvider>
  )

const lastSaved = () =>
  saveMock.mock.calls[saveMock.mock.calls.length - 1]?.[0]?.sidebarLayout as {
    pinned: string[]
    hidden: string[]
  }

describe("SidebarCustomizer", () => {
  it("renders pinned, more, and hidden rows", () => {
    setLayout(["workflows"], ["logs"])
    renderCustomizer()
    expect(screen.getByTestId("sidebar-customizer-pinned-workflows")).toBeInTheDocument()
    // 'inbox' is neither pinned nor hidden → overflow ("More").
    expect(screen.getByTestId("sidebar-customizer-row-inbox")).toBeInTheDocument()
    // 'logs' is hidden.
    expect(screen.getByTestId("sidebar-customizer-row-logs")).toBeInTheDocument()
  })

  it("unpins a pinned item (move to More)", () => {
    renderCustomizer()
    fireEvent.click(screen.getByTestId("sidebar-customizer-unpin-inbox"))
    expect(lastSaved()).toEqual({ pinned: ["workflows"], hidden: [] })
  })

  it("hides a pinned item", () => {
    renderCustomizer()
    fireEvent.click(screen.getByTestId("sidebar-customizer-hide-workflows"))
    expect(lastSaved()).toEqual({ pinned: ["inbox"], hidden: ["workflows"] })
  })

  it("pins an overflow item", () => {
    renderCustomizer()
    // 'twin' starts in overflow.
    fireEvent.click(screen.getByTestId("sidebar-customizer-pin-twin"))
    expect(lastSaved().pinned).toContain("twin")
  })

  it("hides an overflow item", () => {
    renderCustomizer()
    // 'twin' starts in overflow.
    fireEvent.click(screen.getByTestId("sidebar-customizer-hide-twin"))
    expect(lastSaved().hidden).toContain("twin")
  })

  it("shows a hidden item", () => {
    setLayout(["workflows"], ["logs"])
    renderCustomizer()
    fireEvent.click(screen.getByTestId("sidebar-customizer-show-logs"))
    expect(lastSaved()).toEqual({ pinned: ["workflows"], hidden: [] })
  })

  it("pins a hidden item directly", () => {
    setLayout(["workflows"], ["logs"])
    renderCustomizer()
    fireEvent.click(screen.getByTestId("sidebar-customizer-pin-logs"))
    expect(lastSaved()).toEqual({ pinned: ["workflows", "logs"], hidden: [] })
  })

  it("restore defaults is disabled at the default layout and enabled otherwise", () => {
    setLayout(DEFAULT_SIDEBAR_LAYOUT.pinned, [])
    const { rerender } = renderCustomizer()
    expect(screen.getByTestId("sidebar-customizer-reset")).toBeDisabled()

    act(() => setLayout(["workflows"], []))
    rerender(
      <TooltipProvider>
        <SidebarCustomizer />
      </TooltipProvider>
    )
    expect(screen.getByTestId("sidebar-customizer-reset")).not.toBeDisabled()
  })

  it("restores defaults on click", () => {
    setLayout(["workflows"], ["logs"])
    renderCustomizer()
    fireEvent.click(screen.getByTestId("sidebar-customizer-reset"))
    expect(lastSaved()).toEqual(DEFAULT_SIDEBAR_LAYOUT)
  })

  it("starts a keyboard drag from the grip handle without throwing", () => {
    renderCustomizer()
    const handle = screen.getByTestId("sidebar-customizer-handle-workflows")
    // Exercise the dnd-kit keyboard sensor → handleDragEnd wiring. jsdom has no
    // layout, so this resolves to a no-op reorder, but the handler runs.
    act(() => {
      fireEvent.keyDown(handle, { code: "Space" })
      fireEvent.keyDown(handle, { code: "ArrowDown" })
      fireEvent.keyDown(handle, { code: "Space" })
    })
    expect(screen.getByTestId("sidebar-customizer-pinned-workflows")).toBeInTheDocument()
  })

  it("renders empty-state placeholders", () => {
    setLayout([], [])
    renderCustomizer()
    // No pinned items → pinned empty placeholder.
    expect(screen.getByText("customize.pinnedEmpty")).toBeInTheDocument()
    // Nothing hidden → hidden empty placeholder.
    expect(screen.getByText("customize.hiddenEmpty")).toBeInTheDocument()
  })

  it("shows the More-empty placeholder when every item is pinned or hidden", () => {
    // Derive the full id universe from the real nav registry so this can't go
    // stale when a wave adds a new section. The test runs under the "web"
    // platform (jsdom has no Tauri/Capacitor globals), so no `desktopOnly`
    // filtering happens and the whole catalog is in play. Pinning every id
    // leaves nothing for overflow → the "More" bucket is empty.
    const allIds = SIDEBAR_NAV_META.map((m) => m.id)
    setLayout(allIds, [])
    renderCustomizer()
    expect(screen.getByText("customize.moreEmpty")).toBeInTheDocument()
  })
})
