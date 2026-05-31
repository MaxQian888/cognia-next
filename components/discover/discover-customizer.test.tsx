/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, act } from "@testing-library/react"

import { DiscoverCustomizer } from "./discover-customizer"
import { TooltipProvider } from "@/components/ui/tooltip"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { DEFAULT_DISCOVER_LAYOUT } from "@/lib/discover/categories"

jest.mock("next-intl", () => ({
  // Echo the leaf key; `categories.<id>` renders as "categories.<id>".
  useTranslations: () => (key: string) => key,
}))

const saveMock = jest.fn(
  async (_patch?: { discoverLayout?: { pinned: string[]; hidden: string[] } }) => {}
)

function setLayout(pinned: string[], hidden: string[]) {
  useSettingsStore.setState({
    settings: { discoverLayout: { pinned, hidden } } as never,
    save: saveMock as never,
  })
}

beforeEach(() => {
  saveMock.mockClear()
  setLayout(["characters", "skills"], [])
})

const renderCustomizer = () =>
  render(
    <TooltipProvider>
      <DiscoverCustomizer />
    </TooltipProvider>
  )

const lastSaved = () =>
  saveMock.mock.calls[saveMock.mock.calls.length - 1]?.[0]?.discoverLayout as {
    pinned: string[]
    hidden: string[]
  }

describe("DiscoverCustomizer", () => {
  it("renders pinned, more, and hidden rows", () => {
    setLayout(["characters"], ["plugins"])
    renderCustomizer()
    expect(screen.getByTestId("discover-customizer-pinned-characters")).toBeInTheDocument()
    // 'teams' is neither pinned nor hidden → overflow.
    expect(screen.getByTestId("discover-customizer-row-teams")).toBeInTheDocument()
    expect(screen.getByTestId("discover-customizer-row-plugins")).toBeInTheDocument()
  })

  it("unpins a pinned category (move to More)", () => {
    renderCustomizer()
    fireEvent.click(screen.getByTestId("discover-customizer-unpin-skills"))
    expect(lastSaved()).toEqual({ pinned: ["characters"], hidden: [] })
  })

  it("hides a pinned category", () => {
    renderCustomizer()
    fireEvent.click(screen.getByTestId("discover-customizer-hide-characters"))
    expect(lastSaved()).toEqual({ pinned: ["skills"], hidden: ["characters"] })
  })

  it("pins an overflow category", () => {
    renderCustomizer()
    fireEvent.click(screen.getByTestId("discover-customizer-pin-plugins"))
    expect(lastSaved().pinned).toContain("plugins")
  })

  it("shows a hidden category", () => {
    setLayout(["characters"], ["plugins"])
    renderCustomizer()
    fireEvent.click(screen.getByTestId("discover-customizer-show-plugins"))
    expect(lastSaved()).toEqual({ pinned: ["characters"], hidden: [] })
  })

  it("restore defaults is disabled at the default layout", () => {
    setLayout(DEFAULT_DISCOVER_LAYOUT.pinned, DEFAULT_DISCOVER_LAYOUT.hidden)
    renderCustomizer()
    expect(screen.getByTestId("discover-customizer-reset")).toBeDisabled()
  })

  it("restores defaults on click", () => {
    setLayout(["characters"], ["plugins"])
    renderCustomizer()
    fireEvent.click(screen.getByTestId("discover-customizer-reset"))
    expect(lastSaved()).toEqual(DEFAULT_DISCOVER_LAYOUT)
  })

  it("starts a keyboard drag from the grip handle without throwing", () => {
    renderCustomizer()
    const handle = screen.getByTestId("discover-customizer-handle-characters")
    act(() => {
      fireEvent.keyDown(handle, { code: "Space" })
      fireEvent.keyDown(handle, { code: "ArrowDown" })
      fireEvent.keyDown(handle, { code: "Space" })
    })
    expect(screen.getByTestId("discover-customizer-pinned-characters")).toBeInTheDocument()
  })

  it("renders empty-state placeholders", () => {
    setLayout([], [])
    renderCustomizer()
    expect(screen.getByText("customize.pinnedEmpty")).toBeInTheDocument()
    expect(screen.getByText("customize.hiddenEmpty")).toBeInTheDocument()
  })
})
