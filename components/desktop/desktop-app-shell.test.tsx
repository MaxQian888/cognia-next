/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor, act } from "@testing-library/react"
import { renderToString } from "react-dom/server"

const logInfo = jest.fn()
const logWarn = jest.fn()

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const routerPush = jest.fn()
const routerReplace = jest.fn()
let pathname = "/"
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: routerReplace, back: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => pathname,
}))

jest.mock("@cognia/logging", () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
  }),
  loggers: {
    shell: {
      info: (...args: unknown[]) => logInfo(...args),
      warn: (...args: unknown[]) => logWarn(...args),
      error: jest.fn(),
    },
    ui: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    agent: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      child: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
    },
  },
}))

jest.mock("@/lib/db/schema", () => ({
  whenSeeded: jest.fn().mockResolvedValue(undefined),
}))

let platformValue: "tauri" | "mobile" | "web" = "web"
jest.mock("@/hooks/use-platform", () => ({
  usePlatform: () => platformValue,
}))

// Stubbed like the rest of the shell's chrome: what this suite pins is the
// mount, not the bar's own self-hiding rules (finish-setup-bar.test.tsx).
jest.mock("@/components/onboarding/finish-setup-bar", () => ({
  FinishSetupBar: () => <div data-testid="finish-setup-bar-stub" />,
}))
jest.mock("@/components/desktop/title-bar", () => ({
  TitleBar: () => <div data-testid="title-bar" />,
}))
jest.mock("@/components/desktop/status-bar", () => ({
  StatusBar: ({ collapsed }: { collapsed?: boolean }) => (
    <div data-testid="status-bar" data-collapsed={collapsed ? "true" : "false"} />
  ),
}))
jest.mock("@/components/desktop/window-focus-tracker", () => ({
  WindowFocusTracker: () => null,
}))
jest.mock("@/components/desktop/window-resize-edges", () => ({
  WindowResizeEdges: () => <div data-testid="resize-edges" />,
}))
jest.mock("@/components/desktop/zoom-shortcuts", () => ({
  ZoomShortcuts: () => null,
}))
jest.mock("@/components/desktop/command-palette", () => ({
  CommandPalette: () => <div data-testid="command-palette" />,
}))
jest.mock("@/components/shell/guild-rail", () => ({
  GuildRail: ({
    onCreateTeam,
    onOpenSettings,
    collapsed,
  }: {
    onCreateTeam: () => void
    onOpenSettings: () => void
    collapsed?: boolean
  }) => (
    <div data-testid="guild-rail-stub" data-collapsed={collapsed ? "true" : "false"}>
      <button data-testid="guild-create-team" onClick={onCreateTeam} />
      <button data-testid="guild-open-settings" onClick={onOpenSettings} />
    </div>
  ),
}))
jest.mock("@/hooks/desktop/use-menu-event-router", () => ({
  useMenuEventRouter: jest.fn(),
}))
jest.mock("@/components/ui/loading-states", () => ({
  PageLoading: ({ variant, allowReload }: { variant?: string; allowReload?: boolean }) => (
    <div data-testid="page-loading" data-variant={variant} data-allow-reload={allowReload} />
  ),
}))

const uiStateRef = {
  guildRailCollapsed: false,
  statusBarCollapsed: false,
}
jest.mock("@/stores/ui/ui-store", () => ({
  useUIStore: (selector: (s: typeof uiStateRef) => unknown) => selector(uiStateRef),
}))

const settingsStateRef: { settings: { sidebarSide?: "left" | "right" } | undefined } = {
  settings: undefined,
}
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: (selector: (s: typeof settingsStateRef) => unknown) =>
    selector(settingsStateRef),
}))

const toggleSidebarAction = jest.fn()
jest.mock("@/lib/desktop/menu-actions", () => ({
  toggleSidebarAction: () => toggleSidebarAction(),
}))

import { useShellColumnsStore } from "@/stores/ui/shell-columns-store"
import { getAppRegistration, __resetAppRuntimeForTesting } from "@/lib/shortcuts/app-runtime"
import { DesktopAppShell, isShellBypassRoute } from "./desktop-app-shell"

beforeEach(() => {
  logInfo.mockReset()
  logWarn.mockReset()
  routerPush.mockReset()
  routerReplace.mockReset()
  pathname = "/"
  platformValue = "web"
  uiStateRef.guildRailCollapsed = false
  uiStateRef.statusBarCollapsed = false
  act(() => useShellColumnsStore.setState({ sidebarHostsNav: false }))
  settingsStateRef.settings = undefined
  toggleSidebarAction.mockReset()
  __resetAppRuntimeForTesting()
})

test("registers the ⌘B sidebar toggle as an app shortcut that fires the menu action", () => {
  render(
    <DesktopAppShell>
      <div />
    </DesktopAppShell>
  )
  const registration = getAppRegistration("shell.sidebar.toggle")
  expect(registration).toBeDefined()
  // Same behaviour as VS Code: the chord works while the composer has focus.
  expect(registration?.allowInEditable).toBe(true)
  // The catalog gate keeps the DOM binding off under Tauri (native accelerator)
  // and inside Canvas (its rail owns the chord).
  expect(registration?.when).toBe("!view.canvas && !platform.tauri")
  registration?.handler(new KeyboardEvent("keydown", { key: "b", ctrlKey: true }))
  expect(toggleSidebarAction).toHaveBeenCalledTimes(1)
})

test("does not register the sidebar toggle on mobile or on bypass routes", () => {
  platformValue = "mobile"
  const { unmount } = render(
    <DesktopAppShell>
      <div />
    </DesktopAppShell>
  )
  expect(getAppRegistration("shell.sidebar.toggle")).toBeUndefined()
  unmount()
  platformValue = "web"
  pathname = "/share-target"
  render(
    <DesktopAppShell>
      <div />
    </DesktopAppShell>
  )
  expect(getAppRegistration("shell.sidebar.toggle")).toBeUndefined()
})

test("renders TitleBar, StatusBar, GuildRail, CommandPalette, and resize edges", () => {
  render(
    <DesktopAppShell>
      <div data-testid="route-content" />
    </DesktopAppShell>
  )
  expect(screen.getByTestId("title-bar")).toBeInTheDocument()
  expect(screen.getByTestId("status-bar")).toBeInTheDocument()
  expect(screen.getByTestId("guild-create-team")).toBeInTheDocument()
  expect(screen.getByTestId("command-palette")).toBeInTheDocument()
  expect(screen.getByTestId("resize-edges")).toBeInTheDocument()
  expect(screen.getByTestId("route-content")).toBeInTheDocument()
})

test("clicking the rail's Create-team button routes to Settings → Teams", async () => {
  render(
    <DesktopAppShell>
      <div />
    </DesktopAppShell>
  )
  await act(async () => {
    screen.getByTestId("guild-create-team").click()
  })
  await waitFor(() => expect(routerPush).toHaveBeenCalledWith("/settings?section=teams"))
  expect(logInfo).toHaveBeenCalledWith("guild create-team via shell")
})

test("clicking guild settings button routes to /settings", async () => {
  render(
    <DesktopAppShell>
      <div />
    </DesktopAppShell>
  )
  await act(async () => {
    screen.getByTestId("guild-open-settings").click()
  })
  await waitFor(() => expect(routerPush).toHaveBeenCalledWith("/settings"))
})

test("sets data-app-shell on body while mounted, removes on unmount", () => {
  const { unmount } = render(
    <DesktopAppShell>
      <div />
    </DesktopAppShell>
  )
  expect(document.body.getAttribute("data-app-shell")).toBe("true")
  unmount()
  expect(document.body.getAttribute("data-app-shell")).toBeNull()
})

test("SSR / pre-hydration paint emits no chrome (Capacitor /pair flash guard)", () => {
  pathname = "/pair"
  platformValue = "web"
  const html = renderToString(
    <DesktopAppShell>
      <div data-testid="route-content" />
    </DesktopAppShell>
  )
  expect(html).not.toContain("title-bar")
  expect(html).not.toContain("status-bar")
  expect(html).not.toContain("guild-rail-stub")
  expect(html).not.toContain("command-palette")
  expect(html).toContain("route-content")
  // Bypass routes render their target immediately, not the boot loader.
  expect(html).not.toContain("page-loading")
})

test("pre-hydration paint on an ordinary route shows a neutral loader (no chrome, no children)", () => {
  pathname = "/"
  platformValue = "web"
  const html = renderToString(
    <DesktopAppShell>
      <div data-testid="route-content" />
    </DesktopAppShell>
  )
  // Covers the boot/hydration gap with a neutral loader instead of a
  // half-painted shell or bare (empty) client children.
  expect(html).toContain("page-loading")
  expect(html).toContain('data-variant="workspace"')
  expect(html).toContain('data-allow-reload="true"')
  expect(html).not.toContain("route-content")
  expect(html).not.toContain("title-bar")
  expect(html).not.toContain("guild-rail-stub")
})

test("returns children passthrough on mobile (no chrome)", () => {
  platformValue = "mobile"
  render(
    <DesktopAppShell>
      <div data-testid="route-content" />
    </DesktopAppShell>
  )
  expect(screen.queryByTestId("title-bar")).toBeNull()
  expect(screen.queryByTestId("guild-create-team")).toBeNull()
  expect(screen.getByTestId("route-content")).toBeInTheDocument()
})

test("returns children passthrough on bypass routes (no chrome)", () => {
  pathname = "/share-target"
  render(
    <DesktopAppShell>
      <div data-testid="route-content" />
    </DesktopAppShell>
  )
  expect(screen.queryByTestId("title-bar")).toBeNull()
  expect(screen.getByTestId("route-content")).toBeInTheDocument()
  // Bypass routes own the whole viewport and keep the document scroll. While
  // this bar was mounted at the body level it landed *after* their
  // `min-h-[100dvh]` page and showed up as a scrollbar on the pairing flow.
  expect(screen.queryByTestId("finish-setup-bar-stub")).toBeNull()
})

test("renders the first-run takeover bare — setup is not a page inside the app", () => {
  // ADR-0122. The flow draws its own window bar (drag region + window buttons),
  // so a workspace frame around it would be advertising an app the user has
  // not finished setting up — and the residual finish-setup notice would be
  // pointing at the very screen it sits on.
  pathname = "/onboarding"
  render(
    <DesktopAppShell>
      <div data-testid="route-content" />
    </DesktopAppShell>
  )
  expect(screen.queryByTestId("title-bar")).toBeNull()
  expect(screen.queryByTestId("guild-create-team")).toBeNull()
  expect(screen.queryByTestId("finish-setup-bar-stub")).toBeNull()
  expect(screen.getByTestId("route-content")).toBeInTheDocument()
})

test("mounts the finish-setup notice as a row of the shell, not after it", () => {
  // The shell is `h-screen` inside an `overflow:hidden` body: mounted at the
  // body level the bar was laid out past the bottom edge and clipped, so it
  // was visible on no desktop route at all.
  render(
    <DesktopAppShell>
      <div data-testid="route-content" />
    </DesktopAppShell>
  )
  const bar = screen.getByTestId("finish-setup-bar-stub")
  expect(bar).toBeInTheDocument()
  expect(screen.getByTestId("title-bar").compareDocumentPosition(bar)).toBeTruthy()
  expect(
    bar.compareDocumentPosition(screen.getByTestId("route-content")) &
      Node.DOCUMENT_POSITION_FOLLOWING
  ).toBeTruthy()
})

test("does not set data-app-shell on bypass routes", () => {
  pathname = "/canvas/join/abc"
  render(
    <DesktopAppShell>
      <div />
    </DesktopAppShell>
  )
  expect(document.body.getAttribute("data-app-shell")).toBeNull()
})

describe("isShellBypassRoute", () => {
  test("returns false for null/empty", () => {
    expect(isShellBypassRoute(null)).toBe(false)
    expect(isShellBypassRoute(undefined)).toBe(false)
    expect(isShellBypassRoute("")).toBe(false)
  })

  test("matches exact bypass prefix", () => {
    expect(isShellBypassRoute("/share-target")).toBe(true)
    expect(isShellBypassRoute("/pair")).toBe(true)
    expect(isShellBypassRoute("/oauth")).toBe(true)
    expect(isShellBypassRoute("/canvas/join")).toBe(true)
    // The transparent desktop-pet overlay + click popup routes must render
    // full-bleed with no desktop chrome so the frameless windows stay transparent.
    expect(isShellBypassRoute("/pet-overlay")).toBe(true)
    expect(isShellBypassRoute("/island")).toBe(true)
    expect(isShellBypassRoute("/pet-popup")).toBe(true)
    expect(isShellBypassRoute("/selection-toolbar")).toBe(true)
    expect(isShellBypassRoute("/selection-toolbar.html")).toBe(true)
  })

  test("matches nested bypass route", () => {
    expect(isShellBypassRoute("/share-target/abc")).toBe(true)
    expect(isShellBypassRoute("/canvas/join/room-123")).toBe(true)
    expect(isShellBypassRoute("/pet-overlay/foo")).toBe(true)
  })

  test("does not match unrelated routes", () => {
    expect(isShellBypassRoute("/")).toBe(false)
    expect(isShellBypassRoute("/workflows")).toBe(false)
    expect(isShellBypassRoute("/canvas")).toBe(false)
    expect(isShellBypassRoute("/share-targeting")).toBe(false)
  })
})

describe("collapse toggles from ui-store", () => {
  test("collapses — rather than unmounts — the guild rail when guildRailCollapsed is true", () => {
    // Unmounting dropped 56px out of the window in one frame. The rail stays in
    // the DOM and animates its own width to zero; a CSS transition needs the
    // element on both sides of the change.
    uiStateRef.guildRailCollapsed = true
    render(
      <DesktopAppShell>
        <div data-testid="route-content" />
      </DesktopAppShell>
    )
    expect(screen.getByTestId("guild-rail-stub")).toHaveAttribute("data-collapsed", "true")
    expect(screen.getByTestId("route-content")).toBeInTheDocument()
  })

  test("collapses the guild rail while the expanded sidebar hosts the navigation, and brings it back", () => {
    // This flag flips *with* the conversation sidebar's own width animation, so
    // it is the case that most needs to collapse rather than disappear: a
    // smooth 260px collapse used to end on an instant 56px jolt the other way.
    act(() => useShellColumnsStore.setState({ sidebarHostsNav: true }))
    const { rerender } = render(
      <DesktopAppShell>
        <div data-testid="route-content" />
      </DesktopAppShell>
    )
    expect(screen.getByTestId("guild-rail-stub")).toHaveAttribute("data-collapsed", "true")
    // Sidebar collapsed / left `/`: the rows are gone, the icon column returns.
    act(() => useShellColumnsStore.setState({ sidebarHostsNav: false }))
    rerender(
      <DesktopAppShell>
        <div data-testid="route-content" />
      </DesktopAppShell>
    )
    expect(screen.getByTestId("guild-rail-stub")).toHaveAttribute("data-collapsed", "false")
  })

  test("collapses — rather than unmounts — the status bar when statusBarCollapsed is true", () => {
    uiStateRef.statusBarCollapsed = true
    render(
      <DesktopAppShell>
        <div data-testid="route-content" />
      </DesktopAppShell>
    )
    expect(screen.getByTestId("status-bar")).toHaveAttribute("data-collapsed", "true")
    expect(screen.getByTestId("route-content")).toBeInTheDocument()
  })

  test("renders both when collapsed flags are false", () => {
    render(
      <DesktopAppShell>
        <div data-testid="route-content" />
      </DesktopAppShell>
    )
    expect(screen.getByTestId("guild-rail-stub")).toBeInTheDocument()
    expect(screen.getByTestId("status-bar")).toBeInTheDocument()
  })
})

describe("navigation rail placement", () => {
  /** DOM order of the rail stub relative to the routed content. */
  const railComesBeforeContent = () => {
    const rail = screen.getByTestId("guild-rail-stub")
    const content = screen.getByTestId("route-content")
    // Node.DOCUMENT_POSITION_FOLLOWING — content comes after the rail.
    return Boolean(rail.compareDocumentPosition(content) & Node.DOCUMENT_POSITION_FOLLOWING)
  }

  const renderShell = () =>
    render(
      <DesktopAppShell>
        <div data-testid="route-content" />
      </DesktopAppShell>
    )

  test("defaults to the leading edge", () => {
    platformValue = "tauri"
    renderShell()
    expect(railComesBeforeContent()).toBe(true)
  })

  test("moves to the trailing edge when the setting says right", () => {
    platformValue = "tauri"
    settingsStateRef.settings = { sidebarSide: "right" }
    renderShell()
    expect(railComesBeforeContent()).toBe(false)
  })

  // The extension host bar appears only once a plugin registers a surface. The
  // rail has to be outermost on whichever edge it takes, or every activation
  // would slide it sideways.
  test.each([
    ["right", "lastElementChild"],
    ["left", "firstElementChild"],
  ] as const)("on the %s edge it is the row's %s", (side, position) => {
    platformValue = "tauri"
    settingsStateRef.settings = { sidebarSide: side }
    renderShell()
    const rail = screen.getByTestId("guild-rail-stub")
    expect(rail.parentElement?.[position]).toBe(rail)
  })
})
