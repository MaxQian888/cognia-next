/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Suspense, useState } from "react"
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
  def: { id: string; location?: string; title: string; icon: string; order?: number }
}> = []
jest.mock("@/lib/plugin/registries/view-container-registry", () => ({
  subscribeViewContainers: () => () => {},
  getViewContainerSnapshot: () => containers,
}))
jest.mock("@/lib/plugin/context-keys/context-key-store", () => ({
  subscribeContextKeys: () => () => {},
  getContextKeyRevision: () => 0,
  evaluateContextWhen: () => true,
  useContextKeyStore: (select: (state: { keys: Record<string, unknown> }) => unknown) =>
    select({ keys: {} }),
}))
jest.mock("@/components/shell/plugin-view-container-panel", () => ({
  ResolvedRailIcon: ({ name }: { name: string }) => <span data-testid={`icon-${name}`} />,
}))
jest.mock("@/lib/plugin/i18n/plugin-label", () => ({
  resolvePluginLabel: (_t: unknown, _p: string, _k: string | undefined, title: string) => title,
}))

import { SidebarNavSection, SidebarRow } from "./sidebar-nav-section"
import { __resetNavBadgesForTests, setNavBadgeSourceCount } from "@/lib/shell/nav-badges"

const saveMock = jest.fn(
  async (_patch?: { sidebarLayout?: { pinned: string[]; hidden: string[] } }) => {}
)
const lastSavedLayout = () =>
  saveMock.mock.calls[saveMock.mock.calls.length - 1]?.[0]?.sidebarLayout as {
    pinned: string[]
    hidden: string[]
  }

beforeEach(() => {
  __resetNavBadgesForTests()
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

  it("can be active with the highlight off and a leading disclosure glyph", () => {
    render(
      <SidebarRow
        active
        highlight={false}
        leading={<span data-testid="leading" />}
        onClick={() => {}}
        icon={<span />}
        label="Row"
        testId="row"
      />
    )
    const row = screen.getByTestId("row")
    expect(row).toHaveAttribute("data-active", "true")
    expect(row).toContainElement(screen.getByTestId("leading"))
    // `MotionSelectionIndicator` renders nothing when inactive: no tint span.
    expect(row.querySelector(".bg-primary\\/10")).toBeNull()
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
  it.each(["inbox", "logs"])(
    "keeps loading feedback visible while %s navigation is suspended",
    async (destination) => {
      const user = userEvent.setup()
      let ready = false
      let resolve!: () => void
      const load = new Promise<void>((done) => {
        resolve = done
      })
      function Route({ route }: { route: string }) {
        if (route !== "/" && !ready) throw load
        return <span>{route}</span>
      }
      function Navigation() {
        const [route, setRoute] = useState("/")
        routerPush.mockImplementation(setRoute)
        return (
          <>
            <SidebarNavSection />
            <Suspense fallback={null}>
              <Route route={route} />
            </Suspense>
          </>
        )
      }
      render(<Navigation />)
      if (destination === "logs") {
        await user.click(screen.getByRole("button", { name: "more" }))
        await user.click(screen.getByTestId("sidebar-nav-more-item-logs"))
      } else {
        await user.click(screen.getByRole("button", { name: "inbox" }))
      }
      const trigger = screen.getByRole("button", {
        name: destination === "logs" ? "more" : "inbox",
      })
      expect(trigger).toHaveAttribute("aria-busy", "true")
      expect(trigger.querySelector(".animate-spin")).toBeInTheDocument()
      // dnd-kit mounts its own (empty) live regions beside the nav's status.
      expect(screen.getByText("loading")).toHaveAttribute("role", "status")
      await act(async () => {
        ready = true
        resolve()
      })
      expect(trigger).toHaveAttribute("aria-busy", "false")
      expect(screen.queryByText("loading")).not.toBeInTheDocument()
    }
  )

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

  it("More groups the overflow into labeled sections and filters them", async () => {
    const user = userEvent.setup()
    render(<SidebarNavSection />)
    await user.click(screen.getByTestId("sidebar-nav-more"))

    // Category headers come back verbatim from the i18n mock.
    expect(screen.getByText("categories.explore")).toBeInTheDocument()
    expect(screen.getByText("categories.agents")).toBeInTheDocument()

    await user.type(screen.getByTestId("sidebar-nav-more-filter"), "logs")
    expect(screen.getByTestId("sidebar-nav-more-item-logs")).toBeInTheDocument()
    expect(screen.queryByTestId("sidebar-nav-more-item-skills")).not.toBeInTheDocument()
    expect(screen.queryByText("categories.explore")).not.toBeInTheDocument()
    expect(screen.getByText("categories.insights")).toBeInTheDocument()
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

  // What each menu action does is `useShellNavModel`'s (`use-shell-nav.test.tsx`)
  // and the menu's own (`nav-item-menu.test.tsx`); these only prove the rows
  // mount that menu bound to the right item.
  it("right-click on a pinned row opens the shared menu, bound to that row", async () => {
    const user = userEvent.setup()
    render(<SidebarNavSection />)
    const [first, second] = DEFAULT_SIDEBAR_LAYOUT.pinned
    fireEvent.contextMenu(screen.getByTestId(`sidebar-nav-feature-${first}`))
    fireEvent.click(screen.getByTestId(`sidebar-nav-feature-${first}-menu-move-down`))
    expect(lastSavedLayout().pinned.slice(0, 2)).toEqual([second, first])

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

  it("follows the stored mode order and leaves hidden modes out", () => {
    containers.push({ fullId: "p:v", pluginId: "p", def: { id: "v", title: "Vault", icon: "x" } })
    act(() => {
      useSettingsStore.setState({
        settings: {
          sidebarLayout: {
            ...DEFAULT_SIDEBAR_LAYOUT,
            modes: { order: ["p:v", "canvas"], hidden: ["canvas"] },
          },
        } as never,
      })
    })
    render(<SidebarNavSection />)
    expect(screen.queryByTestId("sidebar-nav-canvas")).toBeNull()
    expect(screen.getByTestId("sidebar-nav-view-container-p:v")).toBeInTheDocument()
  })

  it("right-click on a mode row opens the shared menu, bound to that mode", () => {
    containers.push({ fullId: "p:v", pluginId: "p", def: { id: "v", title: "Vault", icon: "x" } })
    render(<SidebarNavSection />)
    fireEvent.contextMenu(screen.getByTestId("sidebar-nav-canvas"))
    // A mode has no "More" to move to.
    expect(screen.queryByTestId("sidebar-nav-canvas-menu-unpin")).toBeNull()
    fireEvent.click(screen.getByTestId("sidebar-nav-canvas-menu-move-down"))
    const saved = saveMock.mock.calls[saveMock.mock.calls.length - 1]?.[0] as {
      sidebarLayout: { modes?: { order: string[]; hidden: string[] } }
    }
    expect(saved.sidebarLayout.modes).toEqual({ order: ["p:v", "canvas"], hidden: [] })
  })

  it("a pinned row carries its live count and its ⌥N chord", () => {
    render(<SidebarNavSection />)
    act(() => setNavBadgeSourceCount("inbox.drafts", 5))
    const inbox = screen.getByTestId("sidebar-nav-feature-inbox")
    expect(screen.getByTestId("sidebar-nav-feature-inbox-badge")).toHaveTextContent("5")
    expect(inbox).toHaveAttribute("aria-label", "inbox, badgeCount")
    const slot = DEFAULT_SIDEBAR_LAYOUT.pinned.indexOf("inbox") + 1
    expect(inbox).toHaveAttribute("aria-keyshortcuts", `Alt+${slot}`)
    expect(inbox).toHaveAttribute("title", "shortcutHint")
  })

  it("More shows a dot and names the count when something behind it is waiting", () => {
    render(<SidebarNavSection />)
    expect(screen.queryByTestId("sidebar-nav-more-badge")).toBeNull()
    act(() => setNavBadgeSourceCount("bots.attention", 2))
    expect(screen.getByTestId("sidebar-nav-more-badge")).toBeInTheDocument()
    expect(screen.getByTestId("sidebar-nav-more")).toHaveAttribute("aria-label", "more, badgeCount")
  })

  it("opens More toward the content from a right-docked sidebar", async () => {
    act(() => {
      useSettingsStore.setState({
        settings: { sidebarLayout: { ...DEFAULT_SIDEBAR_LAYOUT }, sidebarSide: "right" } as never,
      })
    })
    const user = userEvent.setup()
    render(<SidebarNavSection />)
    await user.click(screen.getByTestId("sidebar-nav-more"))
    const content = screen
      .getByTestId("sidebar-nav-more-filter")
      .closest("[data-radix-popper-content-wrapper] > *")
    expect(content).toHaveAttribute("data-side", "left")
  })

  it("groups its rows under labelled groups", () => {
    render(<SidebarNavSection />)
    expect(screen.getByRole("group", { name: "workspacesGroup" })).toContainElement(
      screen.getByTestId("sidebar-nav-canvas")
    )
    expect(screen.getByRole("group", { name: "featuresGroup" })).toContainElement(
      screen.getByTestId("sidebar-nav-more")
    )
  })
})
