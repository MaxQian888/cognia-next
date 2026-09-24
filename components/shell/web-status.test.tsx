/** @jest-environment jsdom */
import { StrictMode } from "react"
import { act, render, screen, within } from "@testing-library/react"
import { getBarCatalog, resolveBarLayout } from "@/lib/shell/bar-items"
import { useUIStore } from "@/stores/ui/ui-store"
import { useShellColumnsStore } from "@/stores/ui/shell-columns-store"
import { useTerminalStore } from "@/stores/terminal/terminal-store"
import { useSettingsStore } from "@/stores/settings/settings-store"
import {
  WebStatusProvider,
  WebSessionStatus,
  WebGlobalStatusRail,
  WebGlobalStatusPill,
  WebGlobalStatusInline,
} from "./web-status"

let hidden: string[] = []
let selfHide = false
jest.mock("@/components/shell/use-bar-layout", () => ({
  useBarLayout: () => ({
    resolved: resolveBarLayout(getBarCatalog("status", "tauri"), { order: [], hidden }),
  }),
}))
jest.mock("@/components/desktop/status-bar-zone", () => ({
  StatusBarZone: ({ items }: { items: { id: string }[] }) =>
    selfHide ? null : items.map(({ id }) => <button key={id}>{id}</button>),
}))

beforeEach(() => {
  hidden = []
  selfHide = false
  useUIStore.setState({ guildRailCollapsed: false, statusBarCollapsed: false })
  useShellColumnsStore.setState({ sidebarHostsNav: false })
  useTerminalStore.setState({ panelOpen: false, panelPosition: "bottom", maximized: false })
  useSettingsStore.setState({ settings: undefined })
})

function Hosts({ context = true, composer = true, header = true, enabled = true } = {}) {
  const collapsed = useUIStore((s) => s.guildRailCollapsed)
  const sidebarHostsNav = useShellColumnsStore((s) => s.sidebarHostsNav)
  return (
    <WebStatusProvider enabled={enabled}>
      {header && (
        <header data-testid="chat-header">
          <WebSessionStatus host="header" />
        </header>
      )}
      {composer && (
        <div data-testid="composer-status-cluster">
          <WebSessionStatus host="composer" />
        </div>
      )}
      {context && (
        <div data-testid="context-bar">
          <WebSessionStatus host="context" />
        </div>
      )}
      <WebGlobalStatusRail collapsed={collapsed || sidebarHostsNav} />
      <WebGlobalStatusPill />
    </WebStatusProvider>
  )
}

it("moves session items context → composer → header → nowhere without duplicating global runs", () => {
  const { rerender } = render(
    <StrictMode>
      <Hosts />
    </StrictMode>
  )
  for (const id of ["connectivity", "executionHost", "branch", "sync"]) {
    expect(
      within(screen.getByTestId("context-bar")).getByRole("button", { name: id })
    ).toBeInTheDocument()
    expect(screen.getAllByRole("button", { name: id })).toHaveLength(1)
  }
  expect(
    within(screen.getByTestId("web-status-rail")).getByRole("button", { name: "runStatus" })
  ).toBeInTheDocument()
  rerender(
    <StrictMode>
      <Hosts context={false} />
    </StrictMode>
  )
  expect(
    within(screen.getByTestId("composer-status-cluster")).getByRole("button", {
      name: "connectivity",
    })
  ).toBeInTheDocument()
  rerender(
    <StrictMode>
      <Hosts context={false} composer={false} />
    </StrictMode>
  )
  expect(
    within(screen.getByTestId("chat-header")).getByRole("button", { name: "connectivity" })
  ).toBeInTheDocument()
  rerender(
    <StrictMode>
      <Hosts context={false} composer={false} header={false} />
    </StrictMode>
  )
  expect(screen.queryByRole("button", { name: "connectivity" })).toBeNull()
  expect(screen.getByRole("button", { name: "runStatus" })).toBeInTheDocument()
  rerender(
    <StrictMode>
      <Hosts />
    </StrictMode>
  )
  expect(screen.getAllByRole("button", { name: "connectivity" })).toHaveLength(1)
})

it("chooses only one equal-priority host and releases it on unmount", () => {
  const tree = (first: boolean) => (
    <WebStatusProvider enabled>
      {first && (
        <div key="first" data-testid="first">
          <WebSessionStatus host="header" />
        </div>
      )}
      <div key="second" data-testid="second">
        <WebSessionStatus host="header" />
      </div>
    </WebStatusProvider>
  )
  const { rerender } = render(tree(true))
  expect(
    within(screen.getByTestId("first")).getByRole("button", { name: "sync" })
  ).toBeInTheDocument()
  expect(screen.getByTestId("second")).toBeEmptyDOMElement()
  rerender(tree(false))
  expect(
    within(screen.getByTestId("second")).getByRole("button", { name: "sync" })
  ).toBeInTheDocument()
})

it("does not render status mounts outside the desktop web provider", () => {
  render(<Hosts enabled={false} />)
  expect(screen.queryAllByRole("button")).toHaveLength(0)
})

it.each(["guildRailCollapsed", "sidebarHostsNav"])(
  "uses the opposite corner while %s is true",
  (flag) => {
    useSettingsStore.setState({ settings: { sidebarSide: "right" } as never })
    render(<Hosts />)
    act(() =>
      flag === "guildRailCollapsed"
        ? useUIStore.setState({ guildRailCollapsed: true })
        : useShellColumnsStore.setState({ sidebarHostsNav: true })
    )
    expect(screen.queryByTestId("web-status-rail")).toBeNull()
    expect(screen.getByTestId("web-status-corner-pill")).toHaveClass("left-3", "empty:hidden")
    act(() => useSettingsStore.setState({ settings: { sidebarSide: "left" } as never }))
    expect(screen.getByTestId("web-status-corner-pill")).toHaveClass("right-3")
    act(() => useUIStore.setState({ statusBarCollapsed: true }))
    expect(screen.queryByTestId("web-status-corner-pill")).toBeNull()
    expect(screen.getByTestId("web-status-context")).toBeInTheDocument()
    act(() => {
      useUIStore.setState({ guildRailCollapsed: false })
      useShellColumnsStore.setState({ sidebarHostsNav: false })
    })
    expect(screen.getByTestId("web-status-rail")).toBeInTheDocument()
  }
)

// The pill is fixed to the corner a docked composer's toolbar puts its "⋯"
// in, and sat on top of it. A composer takes the global items instead.
describe("an inline host for the global scope", () => {
  function Shell({ inline = true, second = false }: { inline?: boolean; second?: boolean }) {
    const collapsed = useUIStore((s) => s.guildRailCollapsed)
    const sidebarHostsNav = useShellColumnsStore((s) => s.sidebarHostsNav)
    return (
      <WebStatusProvider enabled>
        {inline && (
          <div data-testid="composer-a">
            <WebGlobalStatusInline />
          </div>
        )}
        {second && (
          <div data-testid="composer-b">
            <WebGlobalStatusInline />
          </div>
        )}
        <WebGlobalStatusRail collapsed={collapsed || sidebarHostsNav} />
        <WebGlobalStatusPill />
      </WebStatusProvider>
    )
  }

  it("takes the global items off the corner pill while it is mounted", () => {
    useShellColumnsStore.setState({ sidebarHostsNav: true })
    const { rerender } = render(<Shell />)
    expect(screen.queryByTestId("web-status-corner-pill")).toBeNull()
    expect(
      within(screen.getByTestId("composer-a")).getByRole("button", { name: "runStatus" })
    ).toBeInTheDocument()
    expect(screen.getAllByRole("button", { name: "runStatus" })).toHaveLength(1)

    rerender(<Shell inline={false} />)
    expect(
      within(screen.getByTestId("web-status-corner-pill")).getByRole("button", {
        name: "runStatus",
      })
    ).toBeInTheDocument()
  })

  it("renders in one place only, with two composers mounted", () => {
    useShellColumnsStore.setState({ sidebarHostsNav: true })
    render(<Shell second />)
    expect(screen.getAllByRole("button", { name: "runStatus" })).toHaveLength(1)
    expect(screen.getByTestId("composer-b")).toBeEmptyDOMElement()
  })

  it("stays empty while the rail hosts the global scope, or the status bar is collapsed", () => {
    render(<Shell />)
    expect(screen.getByTestId("composer-a")).toBeEmptyDOMElement()
    expect(
      within(screen.getByTestId("web-status-rail")).getByRole("button", { name: "runStatus" })
    ).toBeInTheDocument()

    act(() => {
      useUIStore.setState({ guildRailCollapsed: true, statusBarCollapsed: true })
    })
    expect(screen.getByTestId("composer-a")).toBeEmptyDOMElement()
    expect(screen.queryByTestId("web-status-corner-pill")).toBeNull()
  })

  it("renders nothing outside the web provider", () => {
    render(<WebGlobalStatusInline />)
    expect(screen.queryByTestId("web-status-global-inline")).toBeNull()
  })
})

it("keeps the pill empty when all segments self-hide", () => {
  selfHide = true
  useUIStore.setState({ guildRailCollapsed: true })
  render(<Hosts />)
  expect(screen.getByTestId("web-status-corner-pill")).toBeEmptyDOMElement()
})

it("honors hidden layout items in both scopes", () => {
  hidden = ["connectivity", "runStatus"]
  render(<Hosts />)
  expect(screen.queryByRole("button", { name: "connectivity" })).toBeNull()
  expect(screen.queryByRole("button", { name: "runStatus" })).toBeNull()
})

it("tracks actual bottom dock height, resizes, close, moves, and maximization", () => {
  const previous = global.ResizeObserver
  let measure = () => {}
  const disconnect = jest.fn()
  global.ResizeObserver = class {
    constructor(callback: () => void) {
      measure = callback
    }
    observe() {}
    disconnect = disconnect
    unobserve() {}
  } as unknown as typeof ResizeObserver
  const dock = document.createElement("div")
  dock.dataset.testid = "terminal-dock-region"
  dock.dataset.position = "bottom"
  dock.dataset.open = "true"
  let height = 200
  dock.getBoundingClientRect = () => ({ height }) as DOMRect
  document.body.append(dock)
  try {
    useUIStore.setState({ guildRailCollapsed: true })
    render(<Hosts />)
    const pill = screen.getByTestId("web-status-corner-pill")
    expect(pill).toHaveStyle({ bottom: "10px" })
    act(() => useTerminalStore.setState({ panelOpen: true }))
    expect(pill).toHaveStyle({ bottom: "210px" })
    act(() => {
      height = 320
      measure()
    })
    expect(pill).toHaveStyle({ bottom: "330px" })
    act(() => useTerminalStore.setState({ maximized: true }))
    expect(pill).toHaveStyle({ bottom: "10px" })
    expect(disconnect).toHaveBeenCalled()
    act(() => useTerminalStore.setState({ maximized: false, panelPosition: "right" }))
    expect(pill).toHaveStyle({ bottom: "10px" })
    act(() => useTerminalStore.setState({ panelPosition: "bottom" }))
    expect(pill).toHaveStyle({ bottom: "330px" })
    act(() => useTerminalStore.setState({ panelOpen: false }))
    expect(pill).toHaveStyle({ bottom: "10px" })
  } finally {
    dock.remove()
    global.ResizeObserver = previous
  }
})

it("has no clearance without a mounted dock", () => {
  useUIStore.setState({ guildRailCollapsed: true })
  useTerminalStore.setState({ panelOpen: true })
  render(<Hosts />)
  expect(screen.getByTestId("web-status-corner-pill")).toHaveStyle({ bottom: "10px" })
})
