/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, act } from "@testing-library/react"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { DEFAULT_SIDEBAR_LAYOUT } from "@/types/shell/sidebar"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const routerPush = jest.fn()
let pathname = "/"
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: jest.fn(), back: jest.fn() }),
  usePathname: () => pathname,
  useSearchParams: () => new URLSearchParams(),
}))

const logInfo = jest.fn()
jest.mock("@cognia/logging", () => {
  const stub = {
    trace: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    fatal: jest.fn(),
    child: function () {
      return this
    },
    withContext: function () {
      return this
    },
  }
  return {
    loggers: new Proxy(
      { ui: { ...stub, info: (...args: unknown[]) => logInfo(...args) } },
      { get: (target: Record<string, unknown>, prop: string) => target[prop] ?? stub }
    ),
    createLogger: () => stub,
  }
})

jest.mock("@/stores/ui", () => ({
  useUIStore: <T,>(
    selector: (s: { selectedGuild: { kind: "dm" }; setSelectedGuild: () => void }) => T
  ): T => selector({ selectedGuild: { kind: "dm" }, setSelectedGuild: () => {} }),
}))
jest.mock("@/hooks/use-platform", () => ({ usePlatform: () => "tauri" }))
// A stable snapshot: `useSyncExternalStore` compares by identity, and a
// fresh `[]` per call would re-render forever.
const NO_CONTAINERS: never[] = []
jest.mock("@/lib/plugin/registries/view-container-registry", () => ({
  subscribeViewContainers: () => () => {},
  getViewContainerSnapshot: () => NO_CONTAINERS,
}))
jest.mock("@/lib/plugin/context-keys/context-key-store", () => ({
  subscribeContextKeys: () => () => {},
  getContextKeyRevision: () => 0,
  evaluateContextWhen: () => true,
}))
jest.mock("@/components/plugins/plugin-extension-slot", () => ({
  PluginExtensionSlot: ({ point }: { point: string }) => <div data-testid={`slot-${point}`} />,
}))

import { SidebarFooter } from "./sidebar-footer"

beforeEach(() => {
  routerPush.mockReset()
  logInfo.mockReset()
  pathname = "/"
  act(() => {
    useSettingsStore.setState({
      settings: { sidebarLayout: { ...DEFAULT_SIDEBAR_LAYOUT } } as never,
      save: jest.fn(async () => {}) as never,
    })
  })
})

describe("SidebarFooter", () => {
  it("opens settings from its row and mounts the rail's bottom plugin slot", () => {
    render(<SidebarFooter />)
    expect(screen.getByTestId("slot-sidebar.left.bottom")).toBeInTheDocument()
    const settings = screen.getByTestId("sidebar-footer-settings")
    expect(settings).toHaveAttribute("aria-label", "openSettings")
    expect(settings).not.toHaveAttribute("aria-current")
    fireEvent.click(settings)
    expect(routerPush).toHaveBeenCalledWith("/settings")
    expect(logInfo).toHaveBeenCalledWith("guild open settings")
  })

  it("lights the row while on a settings route", () => {
    pathname = "/settings/general"
    render(<SidebarFooter />)
    expect(screen.getByTestId("sidebar-footer-settings")).toHaveAttribute("aria-current", "page")
  })
})
