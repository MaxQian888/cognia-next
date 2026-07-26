/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const defaultBarItems = {
  connectivity: true,
  sync: true,
  perf: false,
  accountStatus: true,
  usage: true,
  workspace: true,
  quickActions: true,
  accountTop: true,
}
const mockUiState = {
  sidebarCollapsed: false,
  guildRailCollapsed: false,
  statusBarCollapsed: false,
  toggleSidebar: jest.fn(),
  barItems: { ...defaultBarItems },
  toggleBarItem: jest.fn(),
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

const mockArtifactDockState = {
  dockCollapsed: true,
  toggleDock: jest.fn(),
  openBrowser: jest.fn(),
}
jest.mock("@/stores/artifact/artifact-dock-layout-store", () => ({
  useArtifactDockLayoutStore: (selector: (s: typeof mockArtifactDockState) => unknown) =>
    selector(mockArtifactDockState),
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
    ...rest
  }: {
    children: React.ReactNode
    checked?: boolean
    onCheckedChange?: (v: boolean) => void
  }) => (
    <div
      role="menuitemcheckbox"
      aria-checked={checked}
      onClick={() => onCheckedChange?.(!checked)}
      {...rest}
    >
      {children}
    </div>
  ),
  DropdownMenuItem: ({
    children,
    onSelect,
    ...rest
  }: {
    children: React.ReactNode
    onSelect?: (e: Event) => void
  }) => (
    // Radix fires `onSelect` on activation and closes unless the handler calls
    // preventDefault; the mock reproduces both halves so the "keeps the menu
    // open" assertion is testing something real.
    <div
      role="menuitem"
      onClick={(e) => {
        const selectEvent = new Event("menu-select", { cancelable: true })
        onSelect?.(selectEvent)
        if (selectEvent.defaultPrevented) e.stopPropagation()
      }}
      {...rest}
    >
      {children}
    </div>
  ),
  DropdownMenuRadioGroup: ({
    children,
    value,
    onValueChange,
  }: {
    children: React.ReactNode
    value?: string
    onValueChange?: (v: string) => void
  }) => (
    <div data-radio-value={value} onClick={(e) => radioClick(e, onValueChange)}>
      {children}
    </div>
  ),
  DropdownMenuRadioItem: ({
    children,
    value,
    ...rest
  }: {
    children: React.ReactNode
    value: string
  }) => (
    // `aria-checked` is required for the role; the real Radix item derives it
    // from the group. The mock has no group context, so it reports unchecked —
    // the assertions read `data-radio-value` on the group instead.
    <div role="menuitemradio" aria-checked={false} data-value={value} {...rest}>
      {children}
    </div>
  ),
}))

// Radix routes a radio item's click up to the group's `onValueChange`; the
// inline mock reproduces that by reading the clicked item's `data-value`.
function radioClick(
  e: React.MouseEvent<HTMLDivElement>,
  onValueChange?: (v: string) => void
): void {
  const item = (e.target as HTMLElement).closest("[data-value]")
  const value = item?.getAttribute("data-value")
  if (value) onValueChange?.(value)
}

const mockLogInfo = jest.fn()
const mockLogWarn = jest.fn()
jest.mock("@cognia/logging", () => ({
  loggers: {
    ui: {
      info: (...args: unknown[]) => mockLogInfo(...args),
      warn: (...args: unknown[]) => mockLogWarn(...args),
      error: jest.fn(),
    },
  },
}))

const mockSetTheme = jest.fn()
const themeRef = { value: "system" as string }
jest.mock("next-themes", () => ({
  useTheme: () => ({ theme: themeRef.value, setTheme: mockSetTheme }),
}))

const mockSetLanguage = jest.fn().mockResolvedValue(undefined)
const mockSaveSettings = jest.fn().mockResolvedValue(undefined)
const settingsRef = { webviewZoom: 1.0 as number | undefined, language: "en" as "en" | "zh-CN" }
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) =>
    selector({
      settings: { webviewZoom: settingsRef.webviewZoom },
      language: settingsRef.language,
      setLanguage: mockSetLanguage,
      save: mockSaveSettings,
    }),
}))

const mockApplyZoom = jest.fn(async (n: number) => Math.round(n * 20) / 20)
jest.mock("@/lib/tauri/webview-zoom", () => {
  const actual = jest.requireActual<typeof import("@/lib/tauri/webview-zoom")>(
    "@/lib/tauri/webview-zoom"
  )
  return { ...actual, applyZoom: (n: number) => mockApplyZoom(n) }
})

import { TitleBarLayoutControls } from "./title-bar-layout-controls"

beforeEach(() => {
  mockUiState.sidebarCollapsed = false
  mockUiState.guildRailCollapsed = false
  mockUiState.statusBarCollapsed = false
  mockUiState.toggleSidebar.mockClear()
  mockTerminalState.panelOpen = false
  mockTerminalState.togglePanel.mockClear()
  mockArtifactDockState.dockCollapsed = true
  mockArtifactDockState.toggleDock.mockClear()
  mockArtifactDockState.openBrowser.mockClear()
  mockToggleGuildRail.mockClear()
  mockToggleStatusBar.mockClear()
  mockUiState.barItems = { ...defaultBarItems }
  mockUiState.toggleBarItem.mockClear()
  mockSetTheme.mockClear()
  mockSetLanguage.mockReset().mockResolvedValue(undefined)
  mockSaveSettings.mockReset().mockResolvedValue(undefined)
  mockApplyZoom.mockClear()
  mockLogInfo.mockClear()
  mockLogWarn.mockClear()
  themeRef.value = "system"
  settingsRef.webviewZoom = 1.0
  settingsRef.language = "en"
})

describe("TitleBarLayoutControls", () => {
  // The four always-on quick buttons are gone: they drove the very toggles the
  // dropdown already lists as checkboxes, so the title bar rendered the same
  // state twice. One trigger is the whole in-window surface now.
  it("exposes exactly one trigger, with no standalone panel buttons beside it", () => {
    const { container } = render(<TitleBarLayoutControls />)
    expect(screen.getByTestId("title-bar-customize-layout")).toBeInTheDocument()
    for (const id of [
      "title-bar-toggle-guild-rail",
      "title-bar-toggle-sidebar",
      "title-bar-toggle-right-sidebar",
      "title-bar-toggle-terminal",
    ]) {
      expect(screen.queryByTestId(id)).not.toBeInTheDocument()
    }
    // The quick buttons were `aria-pressed` toggles; nothing in the cluster
    // carries that any more, because panel state is expressed by the menu's
    // checkboxes alone. (The mock inlines menu content, so counting buttons
    // here would also count the zoom stepper that really lives inside the menu.)
    const cluster = container.querySelector('[data-testid="title-bar-layout-controls"]')
    expect(cluster?.querySelectorAll("[aria-pressed]")).toHaveLength(0)
  })

  it("renders a Customize Layout dropdown wiring every panel toggle", () => {
    render(<TitleBarLayoutControls />)
    expect(screen.getByTestId("title-bar-customize-layout")).toBeInTheDocument()
    const items = screen.getAllByRole("menuitemcheckbox")
    // 5 panel toggles + 5 status-bar segments + 3 title-bar segments.
    expect(items).toHaveLength(13)

    fireEvent.click(screen.getByText("toggleGuildRail"))
    fireEvent.click(screen.getByText("toggleSidebar"))
    fireEvent.click(screen.getByText("toggleRightSidebar"))
    fireEvent.click(screen.getByText("toggleStatusBar"))
    fireEvent.click(screen.getByText("toggleTerminal"))
    expect(mockToggleGuildRail).toHaveBeenCalled()
    expect(mockUiState.toggleSidebar).toHaveBeenCalled()
    expect(mockArtifactDockState.toggleDock).toHaveBeenCalled()
    expect(mockToggleStatusBar).toHaveBeenCalled()
    expect(mockTerminalState.togglePanel).toHaveBeenCalled()
  })

  it("reflects panel visibility as the checkbox checked state", () => {
    mockUiState.guildRailCollapsed = true
    render(<TitleBarLayoutControls />)
    const railItem = screen.getByText("toggleGuildRail").closest('[role="menuitemcheckbox"]')
    expect(railItem).toHaveAttribute("aria-checked", "false")
    const sidebarItem = screen.getByText("toggleSidebar").closest('[role="menuitemcheckbox"]')
    expect(sidebarItem).toHaveAttribute("aria-checked", "true")
  })

  it("wires each bar-item checkbox to toggleBarItem and reflects its state", () => {
    mockUiState.barItems = { ...defaultBarItems, perf: false, usage: false }
    render(<TitleBarLayoutControls />)

    // Perf + usage start unchecked; the rest checked.
    expect(screen.getByTestId("title-bar-item-perf")).toHaveAttribute("aria-checked", "false")
    expect(screen.getByTestId("title-bar-item-usage")).toHaveAttribute("aria-checked", "false")
    expect(screen.getByTestId("title-bar-item-connectivity")).toHaveAttribute(
      "aria-checked",
      "true"
    )

    fireEvent.click(screen.getByTestId("title-bar-item-perf"))
    expect(mockUiState.toggleBarItem).toHaveBeenCalledWith("perf")
    fireEvent.click(screen.getByTestId("title-bar-item-workspace"))
    expect(mockUiState.toggleBarItem).toHaveBeenCalledWith("workspace")
    fireEvent.click(screen.getByTestId("title-bar-item-accountTop"))
    expect(mockUiState.toggleBarItem).toHaveBeenCalledWith("accountTop")
  })

  it("reveals the browser panel — relocated from the chat header's globe button", () => {
    render(<TitleBarLayoutControls />)
    fireEvent.click(screen.getByTestId("views-open-browser"))
    expect(mockArtifactDockState.openBrowser).toHaveBeenCalled()
  })

  // Theme / locale / zoom used to hold three permanent slots in the status bar.
  // They are preferences, not status, so they moved in here — but they must
  // still work, or the de-crowding pass would just be a removal.
  describe("relocated appearance controls", () => {
    it("switches the theme and persists it", () => {
      render(<TitleBarLayoutControls />)
      fireEvent.click(screen.getByTestId("views-theme-dark"))
      expect(mockSetTheme).toHaveBeenCalledWith("dark")
      // Without the save, SettingsSyncProvider re-applies the stored theme and
      // silently reverts the choice.
      expect(mockSaveSettings).toHaveBeenCalledWith({ theme: "dark" })
    })

    it("marks the active theme", () => {
      themeRef.value = "light"
      const { container } = render(<TitleBarLayoutControls />)
      expect(container.querySelector("[data-radio-value='light']")).not.toBeNull()
    })

    it("switches the locale", () => {
      render(<TitleBarLayoutControls />)
      fireEvent.click(screen.getByTestId("views-locale-zh"))
      expect(mockSetLanguage).toHaveBeenCalledWith("zh-CN")
    })

    it("steps and resets the zoom, persisting each result", async () => {
      render(<TitleBarLayoutControls />)
      expect(screen.getByTestId("views-zoom-value")).toHaveTextContent("100%")

      fireEvent.click(screen.getByTestId("views-zoom-in"))
      await waitFor(() => expect(mockApplyZoom).toHaveBeenCalledWith(1.1))
      await waitFor(() => expect(mockSaveSettings).toHaveBeenCalledWith({ webviewZoom: 1.1 }))

      fireEvent.click(screen.getByTestId("views-zoom-out"))
      await waitFor(() => expect(mockApplyZoom).toHaveBeenCalledWith(0.9))

      fireEvent.click(screen.getByTestId("views-zoom-reset"))
      await waitFor(() => expect(mockApplyZoom).toHaveBeenCalledWith(1))
    })

    it("logs instead of throwing when the theme fails to persist", async () => {
      mockSaveSettings.mockRejectedValueOnce(new Error("disk full"))
      render(<TitleBarLayoutControls />)
      fireEvent.click(screen.getByTestId("views-theme-dark"))
      // The theme still applies in-session — only the write failed.
      expect(mockSetTheme).toHaveBeenCalledWith("dark")
      await waitFor(() => expect(mockLogWarn).toHaveBeenCalled())
    })

    it("logs instead of throwing when the locale fails to switch", async () => {
      mockSetLanguage.mockRejectedValueOnce(new Error("nope"))
      render(<TitleBarLayoutControls />)
      fireEvent.click(screen.getByTestId("views-locale-zh"))
      await waitFor(() => expect(mockLogWarn).toHaveBeenCalled())
    })

    it("logs instead of throwing when the zoom fails to persist", async () => {
      mockSaveSettings.mockRejectedValueOnce(new Error("nope"))
      render(<TitleBarLayoutControls />)
      fireEvent.click(screen.getByTestId("views-zoom-in"))
      await waitFor(() => expect(mockLogWarn).toHaveBeenCalled())
    })

    it("clamps a persisted zoom that is out of range", () => {
      settingsRef.webviewZoom = 99
      render(<TitleBarLayoutControls />)
      expect(screen.getByTestId("views-zoom-value")).not.toHaveTextContent("9900%")
    })

    it("keeps the menu open while stepping the zoom", () => {
      // Radix closes the menu on select; this row prevents that because
      // adjusting zoom is inherently repeated. The mock stops propagation only
      // when the handler called preventDefault, so a bubbling click reaching
      // the container would mean the guard is gone.
      const reachedContainer = jest.fn()
      render(
        <div onClick={reachedContainer}>
          <TitleBarLayoutControls />
        </div>
      )
      fireEvent.click(screen.getByText("zoomLabel"))
      expect(reachedContainer).not.toHaveBeenCalled()

      // The plain browser item does NOT prevent default, so it still bubbles.
      fireEvent.click(screen.getByTestId("views-open-browser"))
      expect(reachedContainer).toHaveBeenCalled()
    })
  })
})
