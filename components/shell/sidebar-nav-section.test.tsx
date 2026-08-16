/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { SelectedGuild } from "@/stores/ui"
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
    loggers: new Proxy({}, { get: () => stub }),
    createLogger: () => stub,
  }
})

jest.mock("@/components/plugins/plugin-extension-slot", () => ({
  PluginExtensionSlot: () => null,
}))
jest.mock("./shell-layout-dialog", () => ({
  ShellLayoutDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="shell-layout-dialog" /> : null,
}))

let selectedGuild: SelectedGuild = { kind: "dm" }
const setSelectedGuild = jest.fn((g: SelectedGuild) => {
  selectedGuild = g
})
jest.mock("@/stores/ui", () => ({
  useUIStore: <T,>(
    selector: (s: {
      selectedGuild: SelectedGuild
      setSelectedGuild: (g: SelectedGuild) => void
    }) => T
  ): T => selector({ selectedGuild, setSelectedGuild }),
}))
jest.mock("@/hooks/use-platform", () => ({ usePlatform: () => "tauri" }))

const containers: Array<{
  fullId: string
  pluginId: string
  def: { id: string; location?: string; title: string; icon: string }
}> = []
jest.mock("@/lib/plugin/registries/view-container-registry", () => ({
  subscribeViewContainers: () => () => {},
  getViewContainerSnapshot: () => containers,
}))
jest.mock("@/lib/plugin/context-keys/context-key-store", () => ({
  subscribeContextKeys: () => () => {},
  getContextKeyRevision: () => 0,
  evaluateContextWhen: () => true,
}))
jest.mock("@/components/shell/plugin-view-container-panel", () => ({
  ResolvedRailIcon: ({ name }: { name: string }) => <span data-testid={`icon-${name}`} />,
}))
jest.mock("@/lib/plugin/i18n/plugin-label", () => ({
  resolvePluginLabel: (_t: unknown, _p: string, _k: string | undefined, title: string) => title,
}))

import { SidebarNavSection, SidebarRow } from "./sidebar-nav-section"

const saveMock = jest.fn(
  async (_patch?: { sidebarLayout?: { pinned: string[]; hidden: string[] } }) => {}
)
const lastSavedLayout = () =>
  saveMock.mock.calls[saveMock.mock.calls.length - 1]?.[0]?.sidebarLayout as {
    pinned: string[]
    hidden: string[]
  }

beforeEach(() => {
  routerPush.mockReset()
  saveMock.mockClear()
  setSelectedGuild.mockClear()
  selectedGuild = { kind: "dm" }
  pathname = "/"
  containers.length = 0
  act(() => {
    useSettingsStore.setState({
      settings: { sidebarLayout: { ...DEFAULT_SIDEBAR_LAYOUT } } as never,
      save: saveMock as never,
    })
  })
})

describe("SidebarRow", () => {
  it("marks the active row as the current page and carries rest props to the button", () => {
    render(
      <SidebarRow
        active
        onClick={() => {}}
        icon={<span />}
        label="Row"
        testId="row"
        aria-expanded={true}
      />
    )
    const row = screen.getByTestId("row")
    expect(row).toHaveAttribute("aria-current", "page")
    expect(row).toHaveAttribute("aria-expanded", "true")
    expect(row).toHaveAttribute("data-active", "true")
  })

  it("can be active without claiming to be the current page (toggles, section headers)", () => {
    render(
      <SidebarRow
        active
        current={false}
        onClick={() => {}}
        icon={<span />}
        label="Row"
        testId="row"
      />
    )
    expect(screen.getByTestId("row")).not.toHaveAttribute("aria-current")
  })
})

describe("SidebarNavSection", () => {
  it("renders Canvas, every pinned feature as a labelled row, and More", () => {
    render(<SidebarNavSection />)
    expect(screen.getByRole("navigation", { name: "navigation" })).toBeInTheDocument()
    expect(screen.getByTestId("sidebar-nav-canvas")).toHaveTextContent("canvas")
    for (const id of DEFAULT_SIDEBAR_LAYOUT.pinned) {
      expect(screen.getByTestId(`sidebar-nav-feature-${id}`)).toBeInTheDocument()
    }
    expect(screen.getByTestId("sidebar-nav-more")).toHaveTextContent("more")
    // Overflow items are not rows.
    expect(screen.queryByTestId("sidebar-nav-feature-skills")).not.toBeInTheDocument()
  })

  it("switches to the Canvas guild without leaving `/`", () => {
    render(<SidebarNavSection />)
    fireEvent.click(screen.getByTestId("sidebar-nav-canvas"))
    expect(setSelectedGuild).toHaveBeenCalledWith({ kind: "canvas" })
    expect(routerPush).not.toHaveBeenCalled()
  })

  it("navigates to a pinned feature and lights it by route prefix", () => {
    pathname = "/inbox/42"
    render(<SidebarNavSection />)
    const inbox = screen.getByTestId("sidebar-nav-feature-inbox")
    expect(inbox).toHaveAttribute("aria-current", "page")
    fireEvent.click(screen.getByTestId("sidebar-nav-feature-workflows"))
    expect(routerPush).toHaveBeenCalledWith("/workflows")
  })

  it("lists plugin view containers between Canvas and the features", () => {
    containers.push({
      fullId: "p:v",
      pluginId: "p",
      def: { id: "v", title: "Vault", icon: "box" },
    })
    selectedGuild = { kind: "plugin-view", containerId: "p:v" }
    render(<SidebarNavSection />)
    const row = screen.getByTestId("sidebar-nav-view-container-p:v")
    expect(row).toHaveTextContent("Vault")
    expect(row).toHaveAttribute("aria-current", "page")
    expect(screen.getByTestId("icon-box")).toBeInTheDocument()
  })

  it("More opens the overflow, navigates, and pins without navigating", async () => {
    const user = userEvent.setup()
    render(<SidebarNavSection />)
    await user.click(screen.getByTestId("sidebar-nav-more"))
    expect(screen.getByTestId("sidebar-nav-more-item-skills")).toBeInTheDocument()
    await user.click(screen.getByTestId("sidebar-nav-more-pin-skills"))
    expect(lastSavedLayout().pinned).toEqual([...DEFAULT_SIDEBAR_LAYOUT.pinned, "skills"])
    expect(routerPush).not.toHaveBeenCalled()
    await user.click(screen.getByTestId("sidebar-nav-more-item-logs"))
    expect(routerPush).toHaveBeenCalledWith("/logs")
  })

  it("More lights up while an overflow route is current, and opens the customizer", async () => {
    pathname = "/skills"
    const user = userEvent.setup()
    render(<SidebarNavSection />)
    expect(screen.getByTestId("sidebar-nav-more")).toHaveAttribute("data-active", "true")
    expect(screen.getByTestId("sidebar-nav-more")).not.toHaveAttribute("aria-current")
    await user.click(screen.getByTestId("sidebar-nav-more"))
    await user.click(screen.getByTestId("sidebar-nav-more-customize"))
    expect(screen.getByTestId("shell-layout-dialog")).toBeInTheDocument()
  })

  it("right-click on a pinned row offers Move to More and Hide", async () => {
    const user = userEvent.setup()
    render(<SidebarNavSection />)
    await user.pointer({
      keys: "[MouseRight]",
      target: screen.getByTestId("sidebar-nav-feature-inbox"),
    })
    await user.click(screen.getByText("customize.moveToMore"))
    expect(lastSavedLayout().pinned).not.toContain("inbox")

    await user.pointer({
      keys: "[MouseRight]",
      target: screen.getByTestId("sidebar-nav-feature-workflows"),
    })
    await user.click(screen.getByText("customize.hideItem"))
    expect(lastSavedLayout().hidden).toContain("workflows")
  })
})
