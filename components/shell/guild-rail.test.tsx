/**
 * @jest-environment jsdom
 */
import { WebStatusProvider } from "@/components/shell/web-status"

jest.mock("@/components/shell/use-bar-layout", () => ({
  useBarLayout: () => ({
    resolved: {
      zones: {
        start: [{ id: "connectivity" }],
        center: [{ id: "runStatus" }],
        end: [{ id: "notifications" }],
      },
    },
  }),
}))
// Segments are real buttons with arrow-key handlers of their own (a dropdown
// trigger opens on ArrowDown), which is what the rail's roving has to beat.
const mockSegmentKeyDown = jest.fn()
jest.mock("@/components/desktop/status-bar-zone", () => ({
  StatusBarZone: ({ items }: { items: { id: string }[] }) =>
    items.map(({ id }) => (
      <button
        key={id}
        type="button"
        data-testid={`segment-${id}`}
        onKeyDown={(event) => mockSegmentKeyDown(event.key)}
      >
        {id}
      </button>
    )),
}))
import { render, screen, fireEvent, act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Suspense, useState } from "react"
import { TooltipProvider } from "@/components/ui/tooltip"
import type { Team } from "@cognia/agent-config-types"
import type { SelectedGuild } from "@/stores/ui"
import { useSettingsStore } from "@/stores/settings/settings-store"
import {
  DEFAULT_SIDEBAR_LAYOUT,
  DEFAULT_SIDEBAR_SIDE,
  SIDEBAR_NAV_META,
} from "@/types/shell/sidebar"
import { CHROME_BUDGET, countControls } from "@/lib/ui/chrome-budget"
import { SHELL_DOCK_TIMING_CLASS } from "@/lib/ui/shell-dock-motion"
import { GUILD_RAIL_WIDTH_PX } from "@/types/shell/sidebar"

function withTooltipProvider(node: React.ReactNode) {
  return <TooltipProvider>{node}</TooltipProvider>
}

const logInfo = jest.fn()

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
    // A Proxy rather than a literal: the rail's customize dialog reaches
    // `use-bar-layout` → `stores/ui/ui-store` → `lib/plugin`, which transitively
    // touches namespaces beyond `ui` (agent, connectors, …). Enumerating them
    // here would just be a list to keep re-growing.
    loggers: new Proxy(
      { ui: { ...stub, info: (...args: unknown[]) => logInfo(...args) } },
      {
        get: (target: Record<string, unknown>, prop: string) => target[prop] ?? stub,
      }
    ),
    // Pulled in transitively by the plugin extension slot → extension-api → core/logger.
    createLogger: () => stub,
  }
})

jest.mock("@/components/plugins/plugin-extension-slot", () => ({
  PluginExtensionSlot: () => null,
}))

jest.mock("./workspace-switcher", () => ({
  WorkspaceSwitcher: () => <div data-testid="workspace-switcher" />,
}))

const teamsRef: { current: Team[] } = { current: [] }
jest.mock("@/hooks/data", () => ({
  useClientLiveQuery: <T,>(_query: () => Promise<T> | T, _deps: unknown[], _initial: T): T =>
    teamsRef.current as unknown as T,
}))

let guildUnread = { dm: 0, teams: new Map<string, number>(), total: 0 }
const markGuildRead = jest.fn(async (_target: unknown, _scope: unknown) => 1)
jest.mock("@/hooks/shell/use-guild-unread", () => ({
  useGuildUnread: () => guildUnread,
  useGuildUnreadScope: () => ({ kind: "workspace", projectId: "p-test" }),
  markGuildRead: (target: unknown, scope: unknown) =>
    markGuildRead(target as never, scope as never),
}))
const startGuildConversation = jest.fn(async (_options: unknown) => ({}) as never)
jest.mock("@/lib/shell/start-guild-conversation", () => ({
  startGuildConversation: (options: unknown) => startGuildConversation(options as never),
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

let platformValue: "tauri" | "mobile" | "web" = "tauri"
jest.mock("@/hooks/use-platform", () => ({
  usePlatform: () => platformValue,
}))

import { GuildRail } from "./guild-rail"
import { __resetNavBadgesForTests, setNavBadgeSourceCount } from "@/lib/shell/nav-badges"
import { __resetAppRuntimeForTesting, getAppRegistration } from "@/lib/shortcuts/app-runtime"
import { __resetTeamOrderQueueForTests } from "@/hooks/shell/use-ordered-teams"

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
  __resetAppRuntimeForTesting()
  __resetTeamOrderQueueForTests()
  logInfo.mockReset()
  routerPush.mockReset()
  saveMock.mockClear()
  setSelectedGuild.mockReset().mockImplementation((g: SelectedGuild) => {
    selectedGuild = g
  })
  selectedGuild = { kind: "dm" }
  teamsRef.current = []
  guildUnread = { dm: 0, teams: new Map(), total: 0 }
  markGuildRead.mockClear()
  startGuildConversation.mockClear()
  pathname = "/"
  platformValue = "tauri"
  // Default layout: 9 features pinned, 5 auxiliary items in "More".
  act(() => {
    useSettingsStore.setState({
      settings: { sidebarLayout: { ...DEFAULT_SIDEBAR_LAYOUT } } as never,
      save: saveMock as never,
    })
  })
})

test("renders the DM, Canvas, and Settings rail buttons", () => {
  const { container } = render(
    withTooltipProvider(<GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />)
  )
  expect(screen.getByLabelText("directMessages")).toBeInTheDocument()
  expect(screen.getByLabelText("canvas")).toBeInTheDocument()
  expect(screen.getByLabelText("openSettings")).toBeInTheDocument()
  expect(container.querySelector('[data-slot="scroll-area"]')).toHaveClass(
    "[&_[data-slot=scroll-area-scrollbar]]:hidden"
  )
})

test.each(["inbox", "logs"])(
  "keeps rail feedback visible while %s navigation is suspended",
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
          <GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />
          <Suspense fallback={null}>
            <Route route={route} />
          </Suspense>
        </>
      )
    }
    render(withTooltipProvider(<Navigation />))
    if (destination === "logs") {
      await user.click(screen.getByRole("button", { name: "more" }))
      await user.click(screen.getByTestId("guild-more-item-logs"))
    } else {
      await user.click(screen.getByRole("button", { name: "inbox" }))
    }
    const trigger = screen.getByRole("button", { name: destination === "logs" ? "more" : "inbox" })
    expect(trigger).toHaveAttribute("aria-busy", "true")
    expect(trigger.querySelector(".animate-spin")).toBeInTheDocument()
    // dnd-kit mounts its own (empty) live regions beside the rail's status.
    expect(screen.getByText("loading")).toHaveAttribute("role", "status")
    await act(async () => {
      ready = true
      resolve()
    })
    expect(trigger).toHaveAttribute("aria-busy", "false")
    expect(screen.queryByText("loading")).not.toBeInTheDocument()
  }
)

test("does not render the account switcher in the rail", () => {
  render(withTooltipProvider(<GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />))
  expect(screen.queryByTestId("account-switcher")).not.toBeInTheDocument()
})

test("renders a pinned rail button for every default-pinned feature", () => {
  render(withTooltipProvider(<GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />))
  // Three pins, not eleven: the rail keeps the destinations work arrives in.
  for (const key of ["inbox", "workflows", "squads"]) {
    expect(screen.getByLabelText(key)).toBeInTheDocument()
  }
  // Configure-once features and the auxiliary group both live behind "More".
  for (const key of ["twin", "discover", "skills", "plugins", "scheduler", "goals", "logs"]) {
    expect(screen.queryByLabelText(key)).not.toBeInTheDocument()
  }
  expect(screen.getByTestId("guild-more")).toBeInTheDocument()
})

test("the More popover still reaches an unpinned feature", async () => {
  // Unpinning must not equal hiding — every demoted feature is one click away.
  const user = userEvent.setup()
  render(withTooltipProvider(<GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />))
  await user.click(screen.getByTestId("guild-more"))
  expect(screen.getByTestId("guild-more-item-skills")).toBeInTheDocument()
  await user.click(screen.getByTestId("guild-more-item-skills"))
  expect(routerPush).toHaveBeenCalledWith("/skills")
})

test("the More popover can pin an item directly without navigating", async () => {
  const user = userEvent.setup()
  render(withTooltipProvider(<GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />))

  await user.click(screen.getByTestId("guild-more"))
  await user.click(screen.getByTestId("guild-more-pin-skills"))

  expect(lastSavedLayout().pinned).toEqual([...DEFAULT_SIDEBAR_LAYOUT.pinned, "skills"])
  expect(routerPush).not.toHaveBeenCalled()
})

test("the More popover lists the overflow (auxiliary) items + Customize", async () => {
  const user = userEvent.setup()
  render(withTooltipProvider(<GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />))
  await user.click(screen.getByTestId("guild-more"))
  expect(screen.getByTestId("guild-more-item-logs")).toBeInTheDocument()
  expect(screen.getByTestId("guild-more-item-me")).toBeInTheDocument()
  expect(screen.getByTestId("guild-more-item-source-control")).toBeInTheDocument()
  expect(screen.getByTestId("guild-more-customize")).toBeInTheDocument()
})

test("clicking an overflow item navigates to its route", async () => {
  const user = userEvent.setup()
  render(withTooltipProvider(<GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />))
  await user.click(screen.getByTestId("guild-more"))
  await user.click(screen.getByTestId("guild-more-item-logs"))
  expect(routerPush).toHaveBeenCalledWith("/logs")
})

test("the More button is hidden when every catalog item is pinned", () => {
  act(() => {
    useSettingsStore.setState({
      settings: {
        sidebarLayout: {
          pinned: SIDEBAR_NAV_META.map((m) => m.id),
          hidden: [],
        },
      } as never,
    })
  })
  render(withTooltipProvider(<GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />))
  expect(screen.queryByTestId("guild-more")).not.toBeInTheDocument()
})

test("opening Customize from the More popover mounts the customizer dialog", async () => {
  const user = userEvent.setup()
  render(withTooltipProvider(<GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />))
  await user.click(screen.getByTestId("guild-more"))
  await user.click(screen.getByTestId("guild-more-customize"))
  expect(screen.getByTestId("shell-layout-dialog")).toBeInTheDocument()
  expect(screen.getByTestId("sidebar-customizer")).toBeInTheDocument()
})

// What each menu action does is `useShellNavModel`'s (`use-shell-nav.test.tsx`)
// and the menu's own (`nav-item-menu.test.tsx`); the rail's tests only prove
// each button mounts that menu bound to the right item.
test("right-click context menu can hide a pinned item", () => {
  render(withTooltipProvider(<GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />))
  fireEvent.contextMenu(screen.getByLabelText("workflows"))
  // Context menu item label keys are returned verbatim by the i18n mock.
  fireEvent.click(screen.getByText("customize.hideItem"))
  const saved = lastSavedLayout()
  expect(saved.pinned).not.toContain("workflows")
  expect(saved.hidden).toContain("workflows")
})

test("right-click context menu can move a pinned item to More", () => {
  render(withTooltipProvider(<GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />))
  fireEvent.contextMenu(screen.getByLabelText("inbox"))
  fireEvent.click(screen.getByText("customize.moveToMore"))
  const saved = lastSavedLayout()
  expect(saved.pinned).not.toContain("inbox")
  expect(saved.hidden).not.toContain("inbox")
})

test("right-click context menu can open the full customizer", () => {
  render(withTooltipProvider(<GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />))
  fireEvent.contextMenu(screen.getByLabelText("workflows"))
  fireEvent.click(screen.getByText("customize.title"))
  expect(screen.getByTestId("shell-layout-dialog")).toBeInTheDocument()
})

test("the More button reflects the active state when on an overflow route", () => {
  pathname = "/logs"
  render(withTooltipProvider(<GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />))
  // The tint is a shared-layout indicator layer now, not a class on the button
  // — that is what lets it slide between rail buttons instead of blinking.
  const indicator = screen.getByTestId("guild-more").querySelector("span[aria-hidden]")
  expect(indicator?.className).toContain("bg-foreground/[0.07]")
})

test("only the active rail button carries the selection indicator", () => {
  pathname = "/workflows"
  render(withTooltipProvider(<GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />))
  expect(screen.getByLabelText("workflows").querySelector("span[aria-hidden]")).not.toBeNull()
  expect(screen.getByLabelText("inbox").querySelector("span[aria-hidden]")).toBeNull()
})

test("the active rail button also draws the edge bar on the window edge", () => {
  pathname = "/workflows"
  render(withTooltipProvider(<GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />))
  const bar = [...screen.getByLabelText("workflows").querySelectorAll("span[aria-hidden]")].find(
    (el) => el.className.includes("w-[3px]")
  )
  expect(bar).toBeDefined()
  expect(bar?.className).toContain("bg-primary")
  expect(bar?.className).toContain("rounded-pill")
  // Left-docked rail: the bar hangs off the button's left edge, at the column's.
  expect((bar as HTMLElement).style.left).toBe("-10px")
  expect(screen.getByLabelText("inbox").querySelector("span[aria-hidden]")).toBeNull()
})

test("a selected team button shows the active boxShadow when on the home route", () => {
  teamsRef.current = [
    {
      id: "t-1",
      name: "Alpha",
      members: [],
      orchestration: "round_robin",
      createdAt: 0,
      updatedAt: 0,
    },
  ] as unknown as Team[]
  selectedGuild = { kind: "team", teamId: "t-1" }
  render(withTooltipProvider(<GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />))
  expect(screen.getByLabelText("Alpha")).toHaveAttribute("aria-current", "page")
})

test("clicking DM/team from a feature route routes back to /", async () => {
  pathname = "/workflows"
  teamsRef.current = [
    {
      id: "t-1",
      name: "Alpha",
      members: [],
      orchestration: "round_robin",
      createdAt: 0,
      updatedAt: 0,
    },
  ] as unknown as Team[]
  const user = userEvent.setup()
  render(withTooltipProvider(<GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />))
  await user.click(screen.getByLabelText("directMessages"))
  expect(routerPush).toHaveBeenCalledWith("/")
  routerPush.mockClear()
  await user.click(screen.getByLabelText("Alpha"))
  expect(setSelectedGuild).toHaveBeenCalledWith({ kind: "team", teamId: "t-1" })
  expect(routerPush).toHaveBeenCalledWith("/")
})

test("hides desktop-only overflow items on mobile but keeps the rest in More", async () => {
  platformValue = "mobile"
  const user = userEvent.setup()
  render(withTooltipProvider(<GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />))
  await user.click(screen.getByTestId("guild-more"))
  expect(screen.queryByTestId("guild-more-item-performance")).not.toBeInTheDocument()
  expect(screen.queryByTestId("guild-more-item-source-control")).not.toBeInTheDocument()
  expect(screen.getByTestId("guild-more-item-logs")).toBeInTheDocument()
  expect(screen.getByTestId("guild-more-item-me")).toBeInTheDocument()
})

test("clicking DM/Canvas updates the guild selection and logs", async () => {
  const user = userEvent.setup()
  render(withTooltipProvider(<GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />))
  await user.click(screen.getByLabelText("canvas"))
  expect(setSelectedGuild).toHaveBeenCalledWith({ kind: "canvas" })
  expect(logInfo).toHaveBeenCalledWith("guild switch canvas")
  await user.click(screen.getByLabelText("directMessages"))
  expect(setSelectedGuild).toHaveBeenCalledWith({ kind: "dm" })
})

test("clicking a chat guild while on a feature route also pushes back to /", async () => {
  pathname = "/workflows"
  const user = userEvent.setup()
  render(withTooltipProvider(<GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />))
  await user.click(screen.getByLabelText("canvas"))
  expect(setSelectedGuild).toHaveBeenCalledWith({ kind: "canvas" })
  expect(routerPush).toHaveBeenCalledWith("/")
})

test("clicking a feature button routes to its top-level path", async () => {
  const user = userEvent.setup()
  render(withTooltipProvider(<GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />))
  await user.click(screen.getByLabelText("workflows"))
  expect(routerPush).toHaveBeenCalledWith("/workflows")
  expect(logInfo).toHaveBeenCalledWith(
    "guild navigate feature",
    expect.objectContaining({ route: "/workflows" })
  )
  await user.click(screen.getByLabelText("inbox"))
  expect(routerPush).toHaveBeenCalledWith("/inbox")
})

test("active state highlights the current route", () => {
  pathname = "/workflows/abc/edit"
  render(withTooltipProvider(<GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />))
  expect(screen.getByLabelText("workflows")).toHaveAttribute("aria-current", "page")
  expect(screen.getByLabelText("inbox")).not.toHaveAttribute("aria-current")
})

test("renders one button per team and selecting one switches guild", async () => {
  teamsRef.current = [
    {
      id: "t-1",
      name: "Alpha",
      members: [],
      orchestration: "round_robin",
      createdAt: 0,
      updatedAt: 0,
    },
    {
      id: "t-2",
      name: "Beta",
      members: [],
      orchestration: "round_robin",
      createdAt: 0,
      updatedAt: 0,
    },
  ] as unknown as Team[]
  const user = userEvent.setup()
  render(withTooltipProvider(<GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />))
  await user.click(screen.getByLabelText("Alpha"))
  expect(setSelectedGuild).toHaveBeenCalledWith({ kind: "team", teamId: "t-1" })
  expect(logInfo).toHaveBeenCalledWith("guild switch team", { teamId: "t-1" })
})

const TWO_TEAMS = [
  {
    id: "t-1",
    name: "Alpha",
    members: [],
    orchestration: "round_robin",
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: "t-2",
    name: "Beta",
    members: [],
    orchestration: "round_robin",
    createdAt: 0,
    updatedAt: 0,
  },
] as unknown as Team[]

test("guild buttons carry their unread count, in the badge and in the accessible name", () => {
  teamsRef.current = TWO_TEAMS
  guildUnread = { dm: 3, teams: new Map([["t-1", 120]]), total: 123 }
  render(withTooltipProvider(<GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />))
  expect(screen.getByTestId("guild-dm-unread")).toHaveTextContent("3")
  expect(screen.getByTestId("guild-team-t-1-unread")).toHaveTextContent("99+")
  // Beta has nothing unread — no badge at all, not a zero.
  expect(screen.queryByTestId("guild-team-t-2-unread")).toBeNull()
  // A screen reader gets the count too; the pill itself is aria-hidden.
  expect(screen.getByTestId("guild-dm")).toHaveAttribute(
    "aria-label",
    "directMessages, unreadCount"
  )
  expect(screen.getByTestId("guild-team-t-2")).toHaveAttribute("aria-label", "Beta")
  expect(screen.getByTestId("guild-dm-unread")).toHaveAttribute("aria-hidden")
})

test("right-click on a team button starts a conversation, marks read, or manages teams", () => {
  teamsRef.current = TWO_TEAMS
  guildUnread = { dm: 0, teams: new Map([["t-1", 2]]), total: 2 }
  pathname = "/inbox"
  render(withTooltipProvider(<GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />))

  fireEvent.contextMenu(screen.getByTestId("guild-team-t-1"))
  fireEvent.click(screen.getByTestId("guild-menu-new-t-1"))
  // The rail is mounted on every route, so it starts the conversation through
  // the shared starter (which selects the guild and brings the user home).
  expect(startGuildConversation).toHaveBeenCalledWith(
    expect.objectContaining({
      teamId: "t-1",
      teamTitle: "newConversation",
      pathname: "/inbox",
    })
  )

  fireEvent.contextMenu(screen.getByTestId("guild-team-t-1"))
  fireEvent.click(screen.getByTestId("guild-menu-mark-read-t-1"))
  // Clears within the badge's own workspace reach, never beyond it.
  expect(markGuildRead).toHaveBeenCalledWith(
    { kind: "team", teamId: "t-1" },
    { kind: "workspace", projectId: "p-test" }
  )

  fireEvent.contextMenu(screen.getByTestId("guild-team-t-2"))
  // Nothing unread there — the item is present but inert.
  expect(screen.getByTestId("guild-menu-mark-read-t-2")).toHaveAttribute("data-disabled")
  fireEvent.click(screen.getByTestId("guild-menu-manage-t-2"))
  expect(routerPush).toHaveBeenCalledWith("/settings?section=teams")
})

test("right-click on Direct Messages starts a direct conversation and offers no team management", () => {
  render(withTooltipProvider(<GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />))
  fireEvent.contextMenu(screen.getByTestId("guild-dm"))
  expect(screen.queryByTestId("guild-menu-manage-dm")).toBeNull()
  fireEvent.click(screen.getByTestId("guild-menu-new-dm"))
  expect(startGuildConversation).toHaveBeenCalledWith(expect.objectContaining({ teamId: null }))
})

test("clicking Create team and Settings invoke the props and log", async () => {
  const onCreateTeam = jest.fn()
  const onOpenSettings = jest.fn()
  const user = userEvent.setup()
  render(
    withTooltipProvider(<GuildRail onCreateTeam={onCreateTeam} onOpenSettings={onOpenSettings} />)
  )
  await user.click(screen.getByLabelText("createTeam"))
  expect(onCreateTeam).toHaveBeenCalled()
  expect(logInfo).toHaveBeenCalledWith("guild create team click")
  await user.click(screen.getByLabelText("openSettings"))
  expect(onOpenSettings).toHaveBeenCalled()
  expect(logInfo).toHaveBeenCalledWith("guild open settings")
})

test("stays within the guild-rail chrome control budget", () => {
  // Default state: no teams, no plugin view containers — the floor every user
  // sees on first launch. Ratchet, not a target (lib/ui/chrome-budget.ts).
  const { container } = render(
    withTooltipProvider(<GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />)
  )
  expect(
    countControls(container.querySelector('nav[data-testid="guild-rail"]'))
  ).toBeLessThanOrEqual(CHROME_BUDGET.guildRail)
})

// ── variant ────────────────────────────────────────────────────────────────
// The rail is mounted in two places with opposite width constraints. Only the
// desktop one may carry the `md:` breakpoint gate: `DesktopAppShell` bails out
// of the mobile shell on the Capacitor *runtime*, so a narrow desktop window
// still renders the rail and needs it to collapse. The mobile nav Sheet is the
// opposite case — a phone viewport is never `md`, so the gate blanked the rail.

test("the default rail variant keeps the md breakpoint gate", () => {
  const { container } = render(
    withTooltipProvider(<GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />)
  )
  const aside = container.querySelector('nav[data-testid="guild-rail"]')!
  expect(aside).toHaveAttribute("data-variant", "rail")
  expect(aside.className).toContain("hidden")
  expect(aside.className).toContain("md:flex")
})

// ── collapse ───────────────────────────────────────────────────────────────
// The shell used to render `null` for both reasons this column goes away — the
// View menu's toggle and the expanded sidebar hosting the navigation — which
// dropped 56px out of the window in one frame. It now animates its own width.

test("collapses to zero width instead of unmounting", () => {
  const { container } = render(
    withTooltipProvider(<GuildRail collapsed onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />)
  )
  const aside = container.querySelector('nav[data-testid="guild-rail"]')!
  expect(aside).toHaveStyle({ width: "0px" })
  expect(aside).toHaveAttribute("data-collapsed", "true")
  expect(aside.className).toContain("overflow-hidden")
})

test("expands to the width the shell's own constant names", () => {
  // The title bar sizes its outlets from the rail's *measured* width, so the
  // animating box has to be the `<aside>` this reports — see
  // `stores/ui/shell-columns-store.ts`.
  const { container } = render(
    withTooltipProvider(<GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />)
  )
  const aside = container.querySelector('nav[data-testid="guild-rail"]')!
  expect(aside).toHaveStyle({ width: `${GUILD_RAIL_WIDTH_PX}px` })
  expect(aside).not.toHaveAttribute("data-collapsed")
  expect(aside.className).not.toContain("overflow-hidden")
})

test("keeps the icons at full width behind the clip while it animates", () => {
  const { container, rerender } = render(
    withTooltipProvider(<GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />)
  )
  rerender(
    withTooltipProvider(<GuildRail collapsed onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />)
  )
  const aside = container.querySelector('nav[data-testid="guild-rail"]')!
  expect(aside.className).toContain("transition-[width]")
  expect(aside.className).toContain(SHELL_DOCK_TIMING_CLASS)
  // A fixed-width inner column: the buttons are clipped, never squeezed toward
  // each other frame by frame.
  expect(aside.firstElementChild?.className).toContain("w-14")
})

test.each([
  ["right" as const, "items-start"],
  ["left" as const, "items-end"],
])("anchors the icon column inboard on the %s edge", (sidebarSide, expected) => {
  // A right-side rail slides right, so its column hugs the inboard (left) edge;
  // a left-side rail is the mirror. Anchoring the wrong way eats the rail from
  // the inside instead of sliding it off its own window edge.
  act(() => {
    useSettingsStore.setState({
      settings: { sidebarLayout: { ...DEFAULT_SIDEBAR_LAYOUT }, sidebarSide } as never,
      save: saveMock as never,
    })
  })
  const { container } = render(
    withTooltipProvider(<GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />)
  )
  expect(container.querySelector('nav[data-testid="guild-rail"]')!.className).toContain(expected)
})

test("never collapses the sheet variant, where the rail is the drawer's column", () => {
  const { container } = render(
    withTooltipProvider(
      <GuildRail variant="sheet" collapsed onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />
    )
  )
  const aside = container.querySelector<HTMLElement>('nav[data-testid="guild-rail"]')!
  expect(aside).not.toHaveAttribute("data-collapsed")
  expect(aside.style.width).toBe("")
})

test("the sheet variant renders unconditionally on a phone viewport", () => {
  const { container } = render(
    withTooltipProvider(
      <GuildRail variant="sheet" onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />
    )
  )
  const aside = container.querySelector('nav[data-testid="guild-rail"]')!
  expect(aside).toHaveAttribute("data-variant", "sheet")
  // `hidden` would be `display:none` at every width a phone can be.
  expect(aside.className).not.toContain("hidden")
  expect(aside.className).toContain("flex")
})

test("the sheet variant still reaches every navigation destination", async () => {
  // The regression this guards: mounted-but-invisible. Assert the actual
  // destinations, not just the container.
  const user = userEvent.setup()
  const onOpenSettings = jest.fn()
  render(
    withTooltipProvider(
      <GuildRail variant="sheet" onCreateTeam={jest.fn()} onOpenSettings={onOpenSettings} />
    )
  )
  expect(screen.getByTestId("workspace-switcher")).toBeInTheDocument()
  expect(screen.getByLabelText("directMessages")).toBeInTheDocument()
  expect(screen.getByLabelText("canvas")).toBeInTheDocument()
  for (const key of ["inbox", "workflows", "squads"]) {
    expect(screen.getByLabelText(key)).toBeInTheDocument()
  }
  await user.click(screen.getByTestId("guild-more"))
  expect(screen.getByTestId("guild-more-item-skills")).toBeInTheDocument()

  await user.click(screen.getByLabelText("openSettings"))
  expect(onOpenSettings).toHaveBeenCalled()
})

describe("which edge the rail occupies", () => {
  const setSide = (side: "left" | "right" | undefined) =>
    act(() => {
      useSettingsStore.setState({
        settings: { sidebarLayout: { ...DEFAULT_SIDEBAR_LAYOUT }, sidebarSide: side } as never,
        save: saveMock as never,
      })
    })

  test("defaults to the shipped edge and marks it on the container", () => {
    const { container } = render(
      withTooltipProvider(<GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />)
    )
    expect(container.querySelector('nav[data-testid="guild-rail"]')).toHaveAttribute(
      "data-side",
      DEFAULT_SIDEBAR_SIDE
    )
  })

  test("borders against the workbench on the right, but not on the left", () => {
    setSide("right")
    const { container, rerender } = render(
      withTooltipProvider(<GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />)
    )
    // Both this rail and ContextWorkbench declare data-bg-target="sidebar", so
    // with a wallpaper on, tone alone leaves no seam between them.
    expect(container.querySelector('nav[data-testid="guild-rail"]')!.className).toContain(
      "border-l"
    )

    setSide("left")
    rerender(withTooltipProvider(<GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />))
    // Nothing to its left but the window edge — a border would draw the seam twice.
    expect(container.querySelector('nav[data-testid="guild-rail"]')!.className).not.toContain(
      "border-l"
    )
  })

  // Only the rail-on-the-right direction is asserted through Radix. jsdom has
  // no layout, so every rect Floating UI measures is zero and its collision
  // logic collapses a requested `side="right"` back to "left" — a probe
  // confirms `left` survives and `right` does not. Asserting the mirror case
  // here would be asserting jsdom, not the rail. The `left` edge is covered by
  // the `data-side` assertions above, which are our own markup.
  test("on the right edge the More popover opens inward", async () => {
    setSide("right")
    const user = userEvent.setup()
    render(withTooltipProvider(<GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />))
    await user.click(screen.getByTestId("guild-more"))
    expect(screen.getByTestId("guild-more-item-skills").closest("[data-side]")).toHaveAttribute(
      "data-side",
      "left"
    )
  })

  test("on the right edge tooltips open inward", async () => {
    setSide("right")
    const user = userEvent.setup()
    render(withTooltipProvider(<GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />))
    await user.hover(screen.getByLabelText("directMessages"))
    const tip = await screen.findByRole("tooltip")
    expect(tip.closest("[data-side]")).toHaveAttribute("data-side", "left")
  })

  test("the sheet variant ignores the desktop edge", () => {
    // In the mobile drawer the rail is the leading column with the channel list
    // beside it — not a window edge, so the desktop preference must not reach it.
    setSide("right")
    const { container } = render(
      withTooltipProvider(
        <GuildRail variant="sheet" onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />
      )
    )
    expect(container.querySelector('nav[data-testid="guild-rail"]')).toHaveAttribute(
      "data-side",
      "left"
    )
    expect(container.querySelector('nav[data-testid="guild-rail"]')!.className).not.toContain(
      "border-l"
    )
  })
})

test("mounts global status above Settings outside the squads scroll area", () => {
  const { rerender } = render(
    withTooltipProvider(
      <WebStatusProvider enabled>
        <GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />
      </WebStatusProvider>
    )
  )
  const status = screen.getByTestId("web-status-rail")
  const settings = screen.getByTestId("guild-open-settings")
  expect(status).toContainElement(screen.getByTestId("segment-runStatus"))
  // Settings sits in its context-menu trigger (the "Customize navigation"
  // menu), which is the status rail's sibling in the column — the status
  // rail inside the roving group that enrols its segments.
  expect(status.closest("[data-sidebar-roving-group]")?.parentElement).toBe(
    settings.parentElement?.parentElement
  )
  expect(status.compareDocumentPosition(settings) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(status.closest('[data-slot="scroll-area"]')).toBeNull()
  rerender(
    withTooltipProvider(
      <WebStatusProvider enabled>
        <GuildRail collapsed onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />
      </WebStatusProvider>
    )
  )
  expect(screen.queryByTestId("web-status-rail")).toBeNull()
})

describe("feature badges", () => {
  test("a pinned feature draws its live count and says it in its name", () => {
    render(withTooltipProvider(<GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />))
    act(() => {
      setNavBadgeSourceCount("inbox.drafts", 2)
      setNavBadgeSourceCount("inbox.approvals", 1)
    })
    expect(screen.getByTestId("guild-feature-inbox-unread")).toHaveTextContent("3")
    expect(screen.getByTestId("guild-feature-inbox")).toHaveAttribute(
      "aria-label",
      "inbox, badgeCount"
    )
    expect(screen.queryByTestId("guild-feature-workflows-unread")).toBeNull()
  })

  test("a count behind More puts a dot on More and a number on the entry", async () => {
    const user = userEvent.setup()
    render(withTooltipProvider(<GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />))
    expect(screen.queryByTestId("guild-more-badge")).toBeNull()
    act(() => setNavBadgeSourceCount("agent-runs.attention", 4))
    expect(screen.getByTestId("guild-more-badge")).toBeInTheDocument()
    expect(screen.getByTestId("guild-more")).toHaveAttribute("aria-label", "more, badgeCount")
    await user.click(screen.getByTestId("guild-more"))
    expect(screen.getByTestId("guild-more-badge-agent-runs")).toHaveTextContent("4")
  })

  test("a hidden destination shows no badge anywhere", () => {
    act(() => {
      useSettingsStore.setState({
        settings: {
          sidebarLayout: { pinned: ["workflows"], hidden: ["inbox", "agent-runs"] },
        } as never,
      })
    })
    render(withTooltipProvider(<GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />))
    act(() => setNavBadgeSourceCount("agent-runs.attention", 4))
    expect(screen.queryByTestId("guild-feature-inbox")).toBeNull()
    expect(screen.queryByTestId("guild-more-badge")).toBeNull()
  })
})

describe("pinned shortcuts", () => {
  test("⌥N opens the Nth pinned item, and an empty slot does nothing", () => {
    render(withTooltipProvider(<GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />))
    const event = new KeyboardEvent("keydown", { key: "1", altKey: true, cancelable: true })
    act(() => getAppRegistration("shell.nav.pinned1")!.handler(event))
    expect(routerPush).toHaveBeenCalledWith(`/${DEFAULT_SIDEBAR_LAYOUT.pinned[0]}`)
    expect(event.defaultPrevented).toBe(true)

    routerPush.mockClear()
    act(() =>
      getAppRegistration("shell.nav.pinned9")!.handler(
        new KeyboardEvent("keydown", { key: "9", altKey: true })
      )
    )
    expect(routerPush).not.toHaveBeenCalled()
  })

  test("stands down on a keystroke something else already consumed", () => {
    render(withTooltipProvider(<GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />))
    const event = new KeyboardEvent("keydown", { key: "1", altKey: true, cancelable: true })
    event.preventDefault()
    act(() => getAppRegistration("shell.nav.pinned1")!.handler(event))
    expect(routerPush).not.toHaveBeenCalled()
  })

  test("announces the chord on the pinned buttons, in order", () => {
    render(withTooltipProvider(<GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />))
    DEFAULT_SIDEBAR_LAYOUT.pinned.forEach((id, index) => {
      expect(screen.getByTestId(`guild-feature-${id}`)).toHaveAttribute(
        "aria-keyshortcuts",
        `Alt+${index + 1}`
      )
    })
  })

  test("registers ⌘, for Settings in the web shell's rail", () => {
    const onOpenSettings = jest.fn()
    render(
      withTooltipProvider(<GuildRail onCreateTeam={jest.fn()} onOpenSettings={onOpenSettings} />)
    )
    const registration = getAppRegistration("shell.settings.open")!
    expect(registration.when).toBe("!platform.tauri")
    act(() => registration.handler(new KeyboardEvent("keydown", { key: ",", ctrlKey: true })))
    expect(onOpenSettings).toHaveBeenCalled()
  })

  test("the mobile drawer's copy binds nothing", () => {
    render(
      withTooltipProvider(
        <GuildRail variant="sheet" onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />
      )
    )
    expect(getAppRegistration("shell.nav.pinned1")).toBeUndefined()
    expect(getAppRegistration("shell.settings.open")).toBeUndefined()
  })
})

describe("reordering from the context menus", () => {
  test("a pinned item moves down from its own menu", () => {
    render(withTooltipProvider(<GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />))
    const [first, second] = DEFAULT_SIDEBAR_LAYOUT.pinned
    fireEvent.contextMenu(screen.getByTestId(`guild-feature-${first}`))
    fireEvent.click(screen.getByTestId(`guild-feature-menu-${first}-move-down`))
    expect(lastSavedLayout().pinned.slice(0, 2)).toEqual([second, first])
  })

  test("teams move up and down, with both ends disabled", async () => {
    teamsRef.current = TWO_TEAMS
    render(withTooltipProvider(<GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />))
    fireEvent.contextMenu(screen.getByTestId("guild-team-t-1"))
    expect(screen.getByTestId("guild-menu-move-up-t-1")).toHaveAttribute("data-disabled")
    await act(async () => {
      fireEvent.click(screen.getByTestId("guild-menu-move-down-t-1"))
    })
    const patch = saveMock.mock.calls[saveMock.mock.calls.length - 1]?.[0] as {
      conversationSidebar?: { teamOrder?: string[] }
    }
    expect(patch.conversationSidebar?.teamOrder).toEqual(["t-2", "t-1"])

    fireEvent.contextMenu(screen.getByTestId("guild-team-t-2"))
    expect(screen.getByTestId("guild-menu-move-down-t-2")).toHaveAttribute("data-disabled")
  })

  test("Canvas can be hidden from its own menu, and stays gone once hidden", () => {
    const { unmount } = render(
      withTooltipProvider(<GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />)
    )
    fireEvent.contextMenu(screen.getByTestId("guild-canvas"))
    fireEvent.click(screen.getByTestId("guild-canvas-menu-hide"))
    const saved = saveMock.mock.calls[saveMock.mock.calls.length - 1]?.[0] as {
      sidebarLayout: { modes?: { hidden: string[] } }
    }
    expect(saved.sidebarLayout.modes?.hidden).toEqual(["canvas"])
    unmount()

    act(() => {
      useSettingsStore.setState({
        settings: {
          sidebarLayout: { ...DEFAULT_SIDEBAR_LAYOUT, modes: { order: [], hidden: ["canvas"] } },
        } as never,
      })
    })
    render(withTooltipProvider(<GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />))
    expect(screen.queryByTestId("guild-canvas")).toBeNull()
  })
})

describe("team menu additions", () => {
  test("Edit team deep-links to that team's editor", () => {
    teamsRef.current = TWO_TEAMS
    render(withTooltipProvider(<GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />))
    fireEvent.contextMenu(screen.getByTestId("guild-team-t-2"))
    fireEvent.click(screen.getByTestId("guild-menu-edit-t-2"))
    expect(routerPush).toHaveBeenCalledWith("/settings?section=teams&team=t-2")
  })

  test("muting persists the team and swaps its badge for a muted glyph", async () => {
    teamsRef.current = TWO_TEAMS
    guildUnread = { dm: 0, teams: new Map([["t-1", 3]]), total: 3 }
    render(withTooltipProvider(<GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />))
    expect(screen.getByTestId("guild-team-t-1-unread")).toHaveTextContent("3")

    fireEvent.contextMenu(screen.getByTestId("guild-team-t-1"))
    await act(async () => {
      fireEvent.click(screen.getByTestId("guild-menu-mute-t-1"))
    })
    const patch = saveMock.mock.calls[saveMock.mock.calls.length - 1]?.[0] as {
      conversationSidebar?: { mutedTeamIds?: string[] }
    }
    expect(patch.conversationSidebar?.mutedTeamIds).toEqual(["t-1"])

    act(() => {
      useSettingsStore.setState({
        settings: {
          sidebarLayout: { ...DEFAULT_SIDEBAR_LAYOUT },
          conversationSidebar: { mutedTeamIds: ["t-1"] },
        } as never,
      })
    })
    expect(screen.queryByTestId("guild-team-t-1-unread")).toBeNull()
    expect(screen.getByTestId("guild-team-t-1-muted")).toBeInTheDocument()
    expect(screen.getByTestId("guild-team-t-1")).toHaveAttribute("aria-label", "teamMuted")

    fireEvent.contextMenu(screen.getByTestId("guild-team-t-1"))
    expect(screen.getByTestId("guild-menu-mute-t-1")).toHaveTextContent("unmuteTeam")
  })
})

describe("accessibility", () => {
  test("is a labelled navigation landmark with labelled groups", () => {
    teamsRef.current = TWO_TEAMS
    render(withTooltipProvider(<GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />))
    const nav = screen.getByRole("navigation", { name: "navigation" })
    expect(nav.tagName).toBe("NAV")
    for (const name of ["workspacesGroup", "featuresGroup", "teamsGroup"]) {
      expect(screen.getByRole("group", { name })).toBeInTheDocument()
    }
    expect(screen.getByRole("group", { name: "teamsGroup" })).toContainElement(
      screen.getByTestId("guild-team-t-1")
    )
  })

  test("takes one tab stop and moves between buttons with the arrow keys", () => {
    render(withTooltipProvider(<GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />))
    const dm = screen.getByTestId("guild-dm")
    // DM is the active destination on `/`, so it holds the tab stop.
    expect(dm).toHaveAttribute("tabindex", "0")
    const canvas = screen.getByTestId("guild-canvas")
    expect(canvas).toHaveAttribute("tabindex", "-1")
    dm.focus()
    fireEvent.keyDown(dm, { key: "ArrowDown" })
    expect(canvas).toHaveFocus()
    fireEvent.keyDown(canvas, { key: "End" })
    expect(screen.getByTestId("guild-open-settings")).toHaveFocus()
    fireEvent.keyDown(screen.getByTestId("guild-open-settings"), { key: "Home" })
    expect(dm).toHaveFocus()
  })

  test("the web shell's status segments join the rail's arrow-key order", () => {
    mockSegmentKeyDown.mockClear()
    render(
      withTooltipProvider(
        <WebStatusProvider enabled>
          <GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />
        </WebStatusProvider>
      )
    )
    const runStatus = screen.getByTestId("segment-runStatus")
    const notifications = screen.getByTestId("segment-notifications")
    const settings = screen.getByTestId("guild-open-settings")
    // Rows of the rail, but not tab stops: DM still holds the only one.
    expect(runStatus).toHaveAttribute("tabindex", "-1")
    expect(notifications).toHaveAttribute("tabindex", "-1")
    expect(screen.getByTestId("guild-dm")).toHaveAttribute("tabindex", "0")

    act(() => settings.focus())
    fireEvent.keyDown(settings, { key: "ArrowUp" })
    expect(notifications).toHaveFocus()
    // Arrowing onto a segment hands it the tab stop.
    expect(notifications).toHaveAttribute("tabindex", "0")
    expect(screen.getByTestId("guild-dm")).toHaveAttribute("tabindex", "-1")
    fireEvent.keyDown(notifications, { key: "ArrowUp" })
    expect(runStatus).toHaveFocus()
    // The rail takes the arrow before the segment's own handler sees it.
    expect(mockSegmentKeyDown).not.toHaveBeenCalled()
    fireEvent.keyDown(runStatus, { key: "End" })
    expect(settings).toHaveFocus()
    // Other keys stay the segment's.
    fireEvent.keyDown(runStatus, { key: "Enter" })
    expect(mockSegmentKeyDown).toHaveBeenCalledWith("Enter")
  })

  test("Settings keeps a way to the customizer even when every item is hidden", () => {
    act(() => {
      useSettingsStore.setState({
        settings: {
          sidebarLayout: { pinned: [], hidden: SIDEBAR_NAV_META.map((m) => m.id) },
        } as never,
      })
    })
    render(withTooltipProvider(<GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />))
    expect(screen.queryByTestId("guild-more")).toBeNull()
    fireEvent.contextMenu(screen.getByTestId("guild-open-settings"))
    fireEvent.click(screen.getByTestId("guild-settings-menu-customize"))
    expect(screen.getByTestId("shell-layout-dialog")).toBeInTheDocument()
  })
})
