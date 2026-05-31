/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const mockUiState = {
  sidebarCollapsed: false,
  guildRailCollapsed: false,
  statusBarCollapsed: false,
  toggleSidebar: jest.fn(),
}
jest.mock("@/stores/ui/ui-store", () => ({
  useUIStore: (selector: (s: typeof mockUiState) => unknown) => selector(mockUiState),
}))

const mockTerminalState = {
  panelOpen: false,
  togglePanel: jest.fn(),
}
jest.mock("@/stores/terminal/terminal-store", () => ({
  useTerminalStore: (selector: (s: typeof mockTerminalState) => unknown) =>
    selector(mockTerminalState),
}))

const mockToggleGuildRail = jest.fn()
const mockToggleStatusBar = jest.fn()
jest.mock("@/lib/desktop/menu-actions", () => ({
  toggleGuildRailAction: () => mockToggleGuildRail(),
  toggleStatusBarAction: () => mockToggleStatusBar(),
}))

// Inline-render the dropdown so checkbox items are directly queryable.
jest.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children, asChild }: { children: React.ReactNode; asChild?: boolean }) =>
    asChild ? <>{children}</> : <button>{children}</button>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuCheckboxItem: ({
    children,
    checked,
    onCheckedChange,
  }: {
    children: React.ReactNode
    checked?: boolean
    onCheckedChange?: (v: boolean) => void
  }) => (
    <div role="menuitemcheckbox" aria-checked={checked} onClick={() => onCheckedChange?.(!checked)}>
      {children}
    </div>
  ),
}))

import { TitleBarLayoutControls } from "./title-bar-layout-controls"

beforeEach(() => {
  mockUiState.sidebarCollapsed = false
  mockUiState.guildRailCollapsed = false
  mockUiState.statusBarCollapsed = false
  mockUiState.toggleSidebar.mockClear()
  mockTerminalState.panelOpen = false
  mockTerminalState.togglePanel.mockClear()
  mockToggleGuildRail.mockClear()
  mockToggleStatusBar.mockClear()
})

describe("TitleBarLayoutControls", () => {
  it("reflects visible panels via aria-pressed on the quick buttons", () => {
    render(<TitleBarLayoutControls />)
    expect(screen.getByTestId("title-bar-toggle-guild-rail")).toHaveAttribute(
      "aria-pressed",
      "true"
    )
    expect(screen.getByTestId("title-bar-toggle-sidebar")).toHaveAttribute("aria-pressed", "true")
    // Terminal starts closed.
    expect(screen.getByTestId("title-bar-toggle-terminal")).toHaveAttribute("aria-pressed", "false")
  })

  it("marks collapsed panels as not pressed", () => {
    mockUiState.guildRailCollapsed = true
    render(<TitleBarLayoutControls />)
    expect(screen.getByTestId("title-bar-toggle-guild-rail")).toHaveAttribute(
      "aria-pressed",
      "false"
    )
  })

  it("wires the quick toggle buttons to their store actions", () => {
    render(<TitleBarLayoutControls />)
    fireEvent.click(screen.getByTestId("title-bar-toggle-guild-rail"))
    expect(mockToggleGuildRail).toHaveBeenCalled()
    fireEvent.click(screen.getByTestId("title-bar-toggle-sidebar"))
    expect(mockUiState.toggleSidebar).toHaveBeenCalled()
    fireEvent.click(screen.getByTestId("title-bar-toggle-terminal"))
    expect(mockTerminalState.togglePanel).toHaveBeenCalled()
  })

  it("renders a Customize Layout dropdown wiring every panel toggle", () => {
    render(<TitleBarLayoutControls />)
    expect(screen.getByTestId("title-bar-customize-layout")).toBeInTheDocument()
    const items = screen.getAllByRole("menuitemcheckbox")
    // Guild rail / sidebar / status bar / terminal.
    expect(items).toHaveLength(4)

    fireEvent.click(screen.getByText("toggleGuildRail"))
    fireEvent.click(screen.getByText("toggleSidebar"))
    fireEvent.click(screen.getByText("toggleStatusBar"))
    fireEvent.click(screen.getByText("toggleTerminal"))
    expect(mockToggleGuildRail).toHaveBeenCalled()
    // toggleSidebar is shared by the quick button + the checkbox item.
    expect(mockUiState.toggleSidebar).toHaveBeenCalled()
    expect(mockToggleStatusBar).toHaveBeenCalled()
    expect(mockTerminalState.togglePanel).toHaveBeenCalled()
  })
})
