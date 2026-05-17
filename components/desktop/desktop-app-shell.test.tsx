/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor, act } from "@testing-library/react"

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

jest.mock("@/lib/logger", () => ({
  loggers: {
    shell: {
      info: (...args: unknown[]) => logInfo(...args),
      warn: (...args: unknown[]) => logWarn(...args),
      error: jest.fn(),
    },
    ui: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  },
}))

jest.mock("@/lib/db/schema", () => ({
  whenSeeded: jest.fn().mockResolvedValue(undefined),
}))

let platformValue: "tauri" | "mobile" | "web" = "web"
jest.mock("@/hooks/use-platform", () => ({
  usePlatform: () => platformValue,
}))

jest.mock("@/components/desktop/title-bar", () => ({
  TitleBar: () => <div data-testid="title-bar" />,
}))
jest.mock("@/components/desktop/status-bar", () => ({
  StatusBar: () => <div data-testid="status-bar" />,
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
jest.mock("@/components/desktop/guild-rail", () => ({
  GuildRail: ({
    onCreateTeam,
    onOpenSettings,
  }: {
    onCreateTeam: () => void
    onOpenSettings: () => void
  }) => (
    <div data-testid="guild-rail-stub">
      <button data-testid="guild-create-team" onClick={onCreateTeam} />
      <button data-testid="guild-open-settings" onClick={onOpenSettings} />
    </div>
  ),
}))
jest.mock("@/hooks/desktop/use-menu-event-router", () => ({
  useMenuEventRouter: jest.fn(),
}))

const uiStateRef = {
  guildRailCollapsed: false,
  statusBarCollapsed: false,
}
jest.mock("@/stores/ui/ui-store", () => ({
  useUIStore: (selector: (s: typeof uiStateRef) => unknown) => selector(uiStateRef),
}))

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
  })

  test("matches nested bypass route", () => {
    expect(isShellBypassRoute("/share-target/abc")).toBe(true)
    expect(isShellBypassRoute("/canvas/join/room-123")).toBe(true)
  })

  test("does not match unrelated routes", () => {
    expect(isShellBypassRoute("/")).toBe(false)
    expect(isShellBypassRoute("/workflows")).toBe(false)
    expect(isShellBypassRoute("/canvas")).toBe(false)
    expect(isShellBypassRoute("/share-targeting")).toBe(false)
  })
})

describe("collapse toggles from ui-store", () => {
  test("hides guild rail when guildRailCollapsed is true", () => {
    uiStateRef.guildRailCollapsed = true
    render(
      <DesktopAppShell>
        <div data-testid="route-content" />
      </DesktopAppShell>
    )
    expect(screen.queryByTestId("guild-rail-stub")).toBeNull()
    expect(screen.getByTestId("route-content")).toBeInTheDocument()
  })

  test("hides status bar when statusBarCollapsed is true", () => {
    uiStateRef.statusBarCollapsed = true
    render(
      <DesktopAppShell>
        <div data-testid="route-content" />
      </DesktopAppShell>
    )
    expect(screen.queryByTestId("status-bar")).toBeNull()
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
