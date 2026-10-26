/**
 * @jest-environment jsdom
 */
import { useEffect, useState } from "react"
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react"
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

jest.mock("@cognia/logging", () => {
  // Namespace-agnostic on purpose. These mocks used to list the handful of
  // `loggers.*` names the suite happened to reach, so the day an import chain
  // grew a new one the whole suite died at load with
  // "Cannot read properties of undefined (reading 'child')" and zero tests ran.
  // A Proxy answers for any namespace, so graph growth cannot go dark here.
  const child: Record<string, unknown> = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    trace: jest.fn(),
  }
  child.child = () => child
  // `shell` keeps the suite's own spies: several tests assert on what the shell
  // logged. Every other namespace falls through to the generic child, which is
  // the point of the Proxy.
  const shell: Record<string, unknown> = {
    ...child,
    info: (...args: unknown[]) => logInfo(...args),
    warn: (...args: unknown[]) => logWarn(...args),
  }
  shell.child = () => shell
  return {
    createLogger: () => child,
    logger: child,
    loggers: new Proxy({} as Record<string, unknown>, {
      get: (_target, prop) => (prop === "shell" ? shell : child),
    }),
  }
})

jest.mock("@/lib/db/schema", () => ({
  whenSeeded: jest.fn().mockResolvedValue(undefined),
}))

let platformValue: "tauri" | "mobile" | "web" = "web"
jest.mock("@/hooks/ui/use-mobile", () => ({ useIsMobile: jest.fn(() => false) }))
import { useIsMobile } from "@/hooks/ui/use-mobile"
// Exercise the real default PlatformShell composition as well as the desktop
// wrapper alone; only unrelated chrome and native services are stubbed.
jest.mock("@/components/mobile/shell/mobile-tab-bar", () => ({
  MobileTabBar: () => <nav aria-label="Compact tabs" />,
  tabHref: (id: string) => `/${id}`,
}))
jest.mock("@/components/mobile/shell/use-mobile-tab-layout", () => ({
  useMobileTabLayout: () => ({ resolved: { defaultLanding: "chat" } }),
}))
jest.mock("@/components/mobile/shell/mobile-global-search-host", () => ({
  MobileGlobalSearchHost: () => null,
}))
jest.mock("@/components/mobile/offline-banner", () => ({ OfflineBanner: () => null }))
jest.mock("@/components/mobile/automation/mobile-consent-sheet", () => ({
  MobileConsentSheet: () => null,
}))
jest.mock("@/hooks/ui/use-keyboard-insets", () => ({
  useKeyboardInsets: () => ({ isVisible: false, keyboardHeight: 0 }),
}))
jest.mock("@/hooks/ui/use-keyboard-viewport-pin", () => ({ useKeyboardViewportPin: jest.fn() }))
jest.mock("@/hooks/shell/use-unread-sessions", () => ({ useMobileUnread: () => ({ chat: 0 }) }))
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (state: { loaded: boolean }) => unknown) =>
    selector({ loaded: true }),
}))
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
jest.mock("@/components/shell/use-bar-layout", () => ({
  useBarLayout: () => ({ resolved: { zones: { start: [], center: [], end: [] } } }),
}))
jest.mock("@/components/desktop/status-bar-zone", () => ({ StatusBarZone: () => null }))
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
  webTitleBarEnabled: false,
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
import { PlatformShell } from "@/components/runtime/platform-shell"
import { PlatformShell as MobilePlatformShell } from "@/components/runtime/platform-shell.mobile"

beforeEach(() => {
  logInfo.mockReset()
  logWarn.mockReset()
  routerPush.mockReset()
  routerReplace.mockReset()
  pathname = "/"
  platformValue = "web"
  jest.mocked(useIsMobile).mockReturnValue(false)
  uiStateRef.guildRailCollapsed = false
  uiStateRef.statusBarCollapsed = false
  uiStateRef.webTitleBarEnabled = false
  act(() => useShellColumnsStore.setState({ sidebarHostsNav: false }))
  settingsStateRef.settings = undefined
  toggleSidebarAction.mockReset()
  __resetAppRuntimeForTesting()
})

test.each([
  [false, DesktopAppShell],
  [true, DesktopAppShell],
  [false, PlatformShell],
  [true, PlatformShell],
] as const)(
  "keeps route state and DOM across web shell switches (initial compact: %s, shell: %p)",
  (initialCompact, Shell) => {
    const mounted = jest.fn()
    const unmounted = jest.fn()
    function StatefulRoute() {
      const [draft, setDraft] = useState("")
      const [open, setOpen] = useState(false)
      useEffect(() => {
        mounted()
        return unmounted
      }, [])
      return (
        <>
          <input
            aria-label="Draft"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <button onClick={() => setOpen(true)}>Open editor</button>
          {open ? <div role="dialog" aria-label="Editor" /> : null}
        </>
      )
    }
    jest.mocked(useIsMobile).mockReturnValue(initialCompact)
    const tree = (
      <Shell>
        <StatefulRoute />
      </Shell>
    )
    const { rerender } = render(tree)
    const input = screen.getByRole("textbox", { name: "Draft" })
    fireEvent.change(input, { target: { value: "Unsaved draft" } })
    fireEvent.click(screen.getByRole("button", { name: "Open editor" }))
    for (const compact of [!initialCompact, initialCompact, !initialCompact]) {
      jest.mocked(useIsMobile).mockReturnValue(compact)
      rerender(
        <Shell>
          <StatefulRoute />
        </Shell>
      )
      expect(screen.getByRole("textbox", { name: "Draft" })).toBe(input)
      expect(input).toHaveValue("Unsaved draft")
      expect(input.isConnected).toBe(true)
      expect(screen.getByRole("dialog", { name: "Editor" })).toBeInTheDocument()
      expect(document.body.hasAttribute("data-app-shell")).toBe(!compact)
      expect(Boolean(screen.queryByTestId("guild-rail-stub"))).toBe(!compact)
      if (Shell === PlatformShell) {
        expect(Boolean(screen.queryByRole("navigation", { name: "Compact tabs" }))).toBe(compact)
      }
    }
    expect(mounted).toHaveBeenCalledTimes(1)
    expect(unmounted).not.toHaveBeenCalled()
  }
)

test("keeps Tauri window controls and route DOM when the viewport narrows", () => {
  platformValue = "tauri"
  const { rerender } = render(
    <PlatformShell>
      <input aria-label="Draft" />
    </PlatformShell>
  )
  const input = screen.getByRole("textbox", { name: "Draft" })
  jest.mocked(useIsMobile).mockReturnValue(true)
  rerender(
    <PlatformShell>
      <input aria-label="Draft" />
    </PlatformShell>
  )
  expect(screen.getByRole("textbox", { name: "Draft" })).toBe(input)
  expect(screen.getByTestId("title-bar")).toBeInTheDocument()
  expect(screen.getByTestId("status-bar")).toBeInTheDocument()
  expect(screen.queryByRole("navigation", { name: "Compact tabs" })).toBeNull()
})

test.each([PlatformShell, MobilePlatformShell])(
  "keeps the Capacitor route and compact chrome at every viewport width (%p)",
  (Shell) => {
    platformValue = "mobile"
    const { rerender } = render(
      <Shell>
        <input aria-label="Draft" />
      </Shell>
    )
    const input = screen.getByRole("textbox", { name: "Draft" })
    fireEvent.change(input, { target: { value: "Native draft" } })
    for (const compact of [true, false, true]) {
      jest.mocked(useIsMobile).mockReturnValue(compact)
      rerender(
        <Shell>
          <input aria-label="Draft" />
        </Shell>
      )
      expect(screen.getByRole("textbox", { name: "Draft" })).toBe(input)
      expect(input).toHaveValue("Native draft")
      expect(screen.getByRole("navigation", { name: "Compact tabs" })).toBeInTheDocument()
      expect(screen.queryByTestId("title-bar")).toBeNull()
      expect(screen.queryByTestId("guild-rail-stub")).toBeNull()
      expect(document.body.hasAttribute("data-app-shell")).toBe(false)
    }
  }
)

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

test("renders GuildRail, CommandPalette, and resize edges without StatusBar — but no TitleBar on the web default", () => {
  render(
    <DesktopAppShell>
      <div data-testid="route-content" />
    </DesktopAppShell>
  )
  // The bar is off by default on the web shell (`webTitleBarEnabled`): a
  // browser tab already has chrome, so the columns draw their own headers.
  expect(screen.queryByTestId("title-bar")).toBeNull()
  expect(screen.queryByTestId("status-bar")).toBeNull()
  expect(screen.getByTestId("guild-create-team")).toBeInTheDocument()
  expect(screen.getByTestId("command-palette")).toBeInTheDocument()
  expect(screen.getByTestId("resize-edges")).toBeInTheDocument()
  expect(screen.getByTestId("route-content")).toBeInTheDocument()
})

test("mounts the TitleBar on web when the setting is on, and always on Tauri", () => {
  uiStateRef.webTitleBarEnabled = true
  const { unmount } = render(
    <DesktopAppShell>
      <div />
    </DesktopAppShell>
  )
  expect(screen.getByTestId("title-bar")).toBeInTheDocument()
  unmount()

  // Tauri ignores the flag either way — the bar is the window chrome there.
  platformValue = "tauri"
  uiStateRef.webTitleBarEnabled = false
  render(
    <DesktopAppShell>
      <div />
    </DesktopAppShell>
  )
  expect(screen.getByTestId("title-bar")).toBeInTheDocument()
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
  // The title bar anchors the ordering assertion, so the bar's web-shell
  // setting is switched on for this one.
  uiStateRef.webTitleBarEnabled = true
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
    platformValue = "tauri"
    uiStateRef.statusBarCollapsed = true
    render(
      <DesktopAppShell>
        <div data-testid="route-content" />
      </DesktopAppShell>
    )
    expect(screen.getByTestId("status-bar")).toHaveAttribute("data-collapsed", "true")
    expect(screen.getByTestId("route-content")).toBeInTheDocument()
  })

  test("renders both on Tauri when collapsed flags are false", () => {
    platformValue = "tauri"
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
