/**
 * @jest-environment jsdom
 */

import { act, render, screen, fireEvent, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const mockUiState = {
  sidebarCollapsed: false,
  guildRailCollapsed: false,
  statusBarCollapsed: false,
  toggleSidebar: jest.fn(),
}

// The per-segment checkboxes moved into the shared customizer, which has its
// own suite (`components/shell/bar-customizer.test.tsx`).
jest.mock("@/components/shell/shell-layout-dialog", () => ({
  ShellLayoutDialog: ({ open, surface }: { open: boolean; surface?: string }) =>
    open ? <div data-testid="shell-layout-dialog" data-surface={surface} /> : null,
}))
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
  unreadArtifact: false,
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
const themeRef = { value: "system" as string | undefined }
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

import { useShellColumnsStore } from "@/stores/ui/shell-columns-store"
import { TitleBarLayoutControls } from "./title-bar-layout-controls"

beforeEach(() => {
  act(() => useShellColumnsStore.setState({ sidebarHostsNav: false, sidebarNavHostCount: 0 }))
  mockUiState.sidebarCollapsed = false
  mockUiState.guildRailCollapsed = false
  mockUiState.statusBarCollapsed = false
  mockUiState.toggleSidebar.mockClear()
  mockTerminalState.panelOpen = false
  mockTerminalState.togglePanel.mockClear()
  mockArtifactDockState.dockCollapsed = true
  mockArtifactDockState.unreadArtifact = false
  mockArtifactDockState.toggleDock.mockClear()
  mockArtifactDockState.openBrowser.mockClear()
  mockToggleGuildRail.mockClear()
  mockToggleStatusBar.mockClear()
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
  it("matches VS Code with one-click primary sidebar, panel, and secondary sidebar toggles", () => {
    render(<TitleBarLayoutControls />)
    expect(screen.getByTestId("title-bar-customize-layout")).toBeInTheDocument()

    const sidebar = screen.getByTestId("title-bar-toggle-sidebar")
    const panel = screen.getByTestId("title-bar-toggle-panel")
    const secondarySidebar = screen.getByTestId("title-bar-toggle-right-sidebar")

    expect(sidebar).toHaveAttribute("aria-pressed", "true")
    expect(panel).toHaveAttribute("aria-pressed", "false")
    expect(secondarySidebar).toHaveAttribute("aria-pressed", "false")
    expect(screen.queryByTestId("title-bar-toggle-guild-rail")).not.toBeInTheDocument()

    fireEvent.click(sidebar)
    fireEvent.click(panel)
    fireEvent.click(secondarySidebar)
    expect(mockUiState.toggleSidebar).toHaveBeenCalled()
    expect(mockTerminalState.togglePanel).toHaveBeenCalled()
    expect(mockArtifactDockState.toggleDock).toHaveBeenCalled()
  })

  // The chat header's own `ArtifactDockToggle` used to carry this dot; that copy
  // is gone now that the bar owns the control on every route, so the signal has
  // to live here or a background artifact arrives silently.
  it("marks the secondary-sidebar toggle when an artifact arrived while the dock was dismissed", () => {
    mockArtifactDockState.dockCollapsed = true
    mockArtifactDockState.unreadArtifact = true
    render(<TitleBarLayoutControls controls={["rightSidebar"]} />)
    const toggle = screen.getByTestId("title-bar-toggle-right-sidebar")
    expect(screen.getByTestId("title-bar-toggle-right-sidebar-unread")).toBeInTheDocument()
    expect(toggle).toHaveAccessibleName("unreadArtifacts")
  })

  it("drops the unread marker once the dock is open", () => {
    mockArtifactDockState.dockCollapsed = false
    mockArtifactDockState.unreadArtifact = true
    render(<TitleBarLayoutControls controls={["rightSidebar"]} />)
    expect(screen.queryByTestId("title-bar-toggle-right-sidebar-unread")).toBeNull()
    expect(screen.getByTestId("title-bar-toggle-right-sidebar")).toHaveAccessibleName(
      "toggleRightSidebar"
    )
  })

  it("can render one independently-customizable title-bar control", () => {
    render(<TitleBarLayoutControls controls={["panel"]} />)
    expect(screen.getByTestId("title-bar-toggle-panel")).toBeInTheDocument()
    expect(screen.queryByTestId("title-bar-toggle-sidebar")).toBeNull()
    expect(screen.queryByTestId("title-bar-toggle-right-sidebar")).toBeNull()
    expect(screen.queryByTestId("title-bar-customize-layout")).toBeNull()
  })

  it("renders a Customize Layout dropdown wiring every panel toggle", () => {
    render(<TitleBarLayoutControls />)
    expect(screen.getByTestId("title-bar-customize-layout")).toBeInTheDocument()
    const items = screen.getAllByRole("menuitemcheckbox")
    // 5 panel toggles. The 8 per-segment checkboxes that used to follow them
    // are gone: they could only toggle visibility, and a menu is the wrong
    // place to drag things into an order.
    expect(items).toHaveLength(5)

    fireEvent.click(screen.getByText("toggleGuildRail"))
    fireEvent.click(screen.getByText("toggleSidebar"))
    fireEvent.click(screen.getByText("toggleRightSidebar"))
    fireEvent.click(screen.getByText("toggleStatusBar"))
    fireEvent.click(screen.getByText("togglePanel"))
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

  it("says the rail is folded into the sidebar while that hosts the navigation", () => {
    act(() => useShellColumnsStore.setState({ sidebarHostsNav: true }))
    render(<TitleBarLayoutControls />)
    // The checkbox still reports the preference (rail on)…
    const railItem = screen.getByTestId("views-toggle-guild-rail")
    expect(railItem).toHaveAttribute("aria-checked", "true")
    // …and says why no rail is drawn right now.
    expect(screen.getByTestId("views-guild-rail-folded")).toHaveTextContent("guildRailFolded")
    // The toggle keeps working — it is the preference for when the rail is
    // back (sidebar collapsed, or any other route).
    fireEvent.click(railItem)
    expect(mockToggleGuildRail).toHaveBeenCalled()
  })

  it("no longer lists the per-segment checkboxes", () => {
    render(<TitleBarLayoutControls />)
    for (const id of ["perf", "usage", "connectivity", "workspace", "accountTop"]) {
      expect(screen.queryByTestId(`title-bar-item-${id}`)).toBeNull()
    }
  })

  it("opens the shared customizer on the top-bar tab", () => {
    render(<TitleBarLayoutControls />)
    expect(screen.queryByTestId("shell-layout-dialog")).toBeNull()
    fireEvent.click(screen.getByTestId("views-customize-bars"))
    const dialog = screen.getByTestId("shell-layout-dialog")
    expect(dialog).toBeInTheDocument()
    // This trigger lives on the title bar, so that is the surface it opens on.
    expect(dialog).toHaveAttribute("data-surface", "title")
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

    // Each of the three rejection paths stringifies non-Error throws too — a
    // rejected promise carrying a bare string must still reach the log with a
    // readable reason rather than "[object Object]".
    it.each([
      [
        "theme",
        "views-theme-dark",
        () => mockSaveSettings.mockRejectedValueOnce("disk full"),
        "views theme persist failed",
      ],
      [
        "locale",
        "views-locale-zh",
        () => mockSetLanguage.mockRejectedValueOnce("nope"),
        "views setLanguage failed",
      ],
      [
        "zoom",
        "views-zoom-in",
        () => mockSaveSettings.mockRejectedValueOnce("nope"),
        "views zoom persist failed",
      ],
    ])("stringifies a non-Error %s failure", async (_what, testId, arrange, message) => {
      arrange()
      render(<TitleBarLayoutControls />)
      fireEvent.click(screen.getByTestId(testId))
      await waitFor(() =>
        expect(mockLogWarn).toHaveBeenCalledWith(message, { error: expect.any(String) })
      )
    })

    it("clamps a persisted zoom that is out of range", () => {
      settingsRef.webviewZoom = 99
      render(<TitleBarLayoutControls />)
      expect(screen.getByTestId("views-zoom-value")).not.toHaveTextContent("9900%")
    })

    it("falls back to the default zoom when none is persisted", () => {
      settingsRef.webviewZoom = undefined
      render(<TitleBarLayoutControls />)
      expect(screen.getByTestId("views-zoom-value")).toHaveTextContent("100%")
    })

    it("falls back to the system theme when next-themes has not rehydrated", () => {
      themeRef.value = undefined
      const { container } = render(<TitleBarLayoutControls />)
      // The mocked radio item cannot report `aria-checked` (no group context),
      // so read the group's resolved value — same convention as "marks the
      // active theme" above.
      expect(container.querySelector("[data-radio-value='system']")).not.toBeNull()
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
