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

let platformValue: "tauri" | "mobile" | "web" = "tauri"
jest.mock("@/hooks/use-platform", () => ({
  usePlatform: () => platformValue,
}))

interface SavePatch {
  sidebarLayout?: { pinned: string[]; hidden: string[] }
  sidebarSide?: "left" | "right"
}

const saveMock = jest.fn(async (_patch?: SavePatch) => {})

function setLayout(pinned: string[], hidden: string[], side?: "left" | "right") {
  useSettingsStore.setState({
    settings: { sidebarLayout: { pinned, hidden }, sidebarSide: side } as never,
    save: saveMock as never,
  })
}

beforeEach(() => {
  saveMock.mockClear()
  platformValue = "tauri"
  setLayout(["workflows", "inbox"], [])
})

const renderCustomizer = () =>
  render(
    <TooltipProvider>
      <SidebarCustomizer />
    </TooltipProvider>
  )

const lastPatch = () => saveMock.mock.calls[saveMock.mock.calls.length - 1]?.[0] as SavePatch

const lastSaved = () =>
  lastPatch()?.sidebarLayout as {
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
    // stale when a wave adds a new section. The suite pins the platform to
    // "tauri", so the catalog is the whole of `SIDEBAR_NAV_META` with no
    // `desktopOnly` filtering. Pinning every id leaves nothing for overflow →
    // the "More" bucket is empty.
    const allIds = SIDEBAR_NAV_META.map((m) => m.id)
    setLayout(allIds, [])
    renderCustomizer()
    expect(screen.getByText("customize.moreEmpty")).toBeInTheDocument()
  })
})

describe("SidebarCustomizer — rail side", () => {
  const sideGroup = () => screen.queryByTestId("sidebar-customizer-side")

  it("is the entry point for choosing the rail's edge", () => {
    renderCustomizer()
    expect(sideGroup()).toBeInTheDocument()
    expect(screen.getByRole("radio", { name: "customize.sideLeft" })).toBeInTheDocument()
    expect(screen.getByRole("radio", { name: "customize.sideRight" })).toBeInTheDocument()
  })

  it("reflects the persisted edge", () => {
    setLayout(["workflows"], [], "left")
    renderCustomizer()
    expect(screen.getByRole("radio", { name: "customize.sideLeft" })).toHaveAttribute(
      "data-state",
      "on"
    )
  })

  it("writes only the side, leaving the layout alone", () => {
    setLayout(["workflows"], [], "right")
    renderCustomizer()
    fireEvent.click(screen.getByRole("radio", { name: "customize.sideLeft" }))
    expect(lastPatch()).toEqual({ sidebarSide: "left" })
  })

  it("keeps the current edge when the pressed item is toggled off", () => {
    // Radix single-type groups emit "" on deselect. The rail has to be on some
    // edge, so that must not reach the store as an empty side.
    setLayout(["workflows"], [], "left")
    renderCustomizer()
    fireEvent.click(screen.getByRole("radio", { name: "customize.sideLeft" }))
    expect(saveMock).not.toHaveBeenCalled()
  })

  it("is hidden on the mobile shell, where the rail has no window edge", () => {
    // The mobile rail lives inside the nav drawer, where there is no edge to pick.
    platformValue = "mobile"
    renderCustomizer()
    expect(sideGroup()).not.toBeInTheDocument()
    // The rest of the customizer still renders.
    expect(screen.getByTestId("sidebar-customizer-pinned-workflows")).toBeInTheDocument()
  })

  it("is offered in the browser too, which also honours the stored edge", () => {
    // `desktop-app-shell.tsx` applies `sidebarSide` for every non-mobile
    // platform. Hiding the toggle on web left those users with the new
    // right-edge default, no way back, and no explanation.
    platformValue = "web"
    renderCustomizer()
    expect(sideGroup()).toBeInTheDocument()
    fireEvent.click(screen.getByRole("radio", { name: "customize.sideLeft" }))
    expect(lastPatch()).toEqual({ sidebarSide: "left" })
  })
})
