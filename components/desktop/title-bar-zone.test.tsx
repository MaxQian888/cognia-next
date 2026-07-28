/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

// Each segment has its own suite; stub them so this one asserts the id →
// component mapping, the ordering, and the responsive breakpoint classes.
jest.mock("@/components/desktop/title-bar-nav-arrows", () => ({
  TitleBarNavArrows: ({ className }: { className?: string }) => (
    <div data-testid="seg-navArrows" className={className} />
  ),
}))
jest.mock("@/components/desktop/title-bar-workspace", () => ({
  TitleBarWorkspace: ({ className }: { className?: string }) => (
    <div data-testid="seg-workspace" className={className} />
  ),
}))
jest.mock("@/components/desktop/title-bar-search-pill", () => ({
  TitleBarSearchPill: ({ appName, onClick }: { appName: string; onClick: () => void }) => (
    <button type="button" data-testid="seg-search" onClick={onClick}>
      {appName}
    </button>
  ),
}))
jest.mock("@/components/desktop/title-bar-command-center-menu", () => ({
  TitleBarCommandCenterMenu: ({ className }: { className?: string }) => (
    <div data-testid="seg-commandCenter" className={className} />
  ),
}))
jest.mock("@/components/desktop/title-bar-quick-actions", () => ({
  TitleBarQuickActions: ({ className }: { className?: string }) => (
    <div data-testid="seg-quickActions" className={className} />
  ),
}))
jest.mock("@/components/desktop/title-bar-layout-controls", () => ({
  TitleBarLayoutControls: ({ className }: { className?: string }) => (
    <div data-testid="seg-layoutControls" className={className} />
  ),
}))
jest.mock("@/components/account/account-bar-button", () => ({
  AccountBarButton: ({ className }: { className?: string }) => (
    <div data-testid="seg-accountTop" className={className} />
  ),
}))

import { TitleBarZone, type TitleBarItemContext } from "./title-bar-zone"
import { getBarCatalog } from "@/lib/shell/bar-items"
import { TITLE_BAR_ITEMS } from "@/types/shell/bars"

const catalog = getBarCatalog("title", "tauri")
const pick = (...ids: string[]) => ids.map((id) => catalog.find((c) => c.id === id)!)

const onCommandPalette = jest.fn()
const ctx: TitleBarItemContext = {
  appName: "Cognia",
  separator: " — ",
  searchPlaceholder: "Search",
  kbdHint: "⌘K",
  recentSessions: [],
  onCommandPalette,
  onOpenRecentSession: jest.fn(),
  onGo: jest.fn(),
}

beforeEach(() => {
  onCommandPalette.mockClear()
})

describe("TitleBarZone", () => {
  it("mounts a component for every catalog id", () => {
    render(<TitleBarZone items={catalog} ctx={ctx} />)
    for (const meta of TITLE_BAR_ITEMS) {
      const testId = meta.id === "appIcon" ? "title-bar-app-icon" : `seg-${meta.id}`
      expect(screen.getByTestId(testId)).toBeInTheDocument()
    }
  })

  it("renders in the order it is given", () => {
    const { container } = render(<TitleBarZone items={pick("search", "navArrows")} ctx={ctx} />)
    const ids = Array.from(container.querySelectorAll("[data-testid]")).map((el) =>
      el.getAttribute("data-testid")
    )
    expect(ids).toEqual(["seg-search", "seg-navArrows"])
  })

  it("passes the bar's context down to the search pill", () => {
    render(<TitleBarZone items={pick("search")} ctx={ctx} />)
    expect(screen.getByTestId("seg-search")).toHaveTextContent("Cognia")
    screen.getByTestId("seg-search").click()
    expect(onCommandPalette).toHaveBeenCalled()
  })

  it("applies each segment's responsive floor so a narrow window sheds them first", () => {
    render(<TitleBarZone items={pick("workspace", "commandCenter", "quickActions")} ctx={ctx} />)
    expect(screen.getByTestId("seg-workspace").className).toContain("hidden lg:flex")
    expect(screen.getByTestId("seg-commandCenter").className).toContain("hidden lg:inline-flex")
    expect(screen.getByTestId("seg-quickActions").className).toContain("hidden xl:flex")
  })

  it("leaves segments without a floor unconstrained", () => {
    render(<TitleBarZone items={pick("navArrows", "accountTop")} ctx={ctx} />)
    expect(screen.getByTestId("seg-navArrows").className).not.toContain("hidden")
    expect(screen.getByTestId("seg-accountTop").className).not.toContain("hidden")
  })

  it("renders nothing for an empty zone", () => {
    const { container } = render(<TitleBarZone items={[]} ctx={ctx} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("skips an id with no component instead of throwing", () => {
    // Unreachable for real catalog ids (the first test pins that), but a stored
    // layout is user data and could name an id a later version removed.
    const ghost = { ...catalog[0], id: "ghost" }
    const { container } = render(<TitleBarZone items={[ghost]} ctx={ctx} />)
    expect(container).toBeEmptyDOMElement()
  })
})
