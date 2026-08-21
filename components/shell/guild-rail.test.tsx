/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent, act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
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
const markGuildRead = jest.fn(async (_target: unknown) => 1)
jest.mock("@/hooks/shell/use-guild-unread", () => ({
  useGuildUnread: () => guildUnread,
  markGuildRead: (target: unknown) => markGuildRead(target as never),
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

const saveMock = jest.fn(
  async (_patch?: { sidebarLayout?: { pinned: string[]; hidden: string[] } }) => {}
)
const lastSavedLayout = () =>
  saveMock.mock.calls[saveMock.mock.calls.length - 1]?.[0]?.sidebarLayout as {
    pinned: string[]
    hidden: string[]
  }

beforeEach(() => {
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
  expect(indicator?.className).toContain("bg-primary/10")
})

test("only the active rail button carries the selection indicator", () => {
  pathname = "/workflows"
  render(withTooltipProvider(<GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />))
  expect(screen.getByLabelText("workflows").querySelector("span[aria-hidden]")).not.toBeNull()
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
  expect(markGuildRead).toHaveBeenCalledWith({ kind: "team", teamId: "t-1" })

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
  expect(countControls(container.querySelector("aside"))).toBeLessThanOrEqual(
    CHROME_BUDGET.guildRail
  )
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
  const aside = container.querySelector("aside")!
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
  const aside = container.querySelector("aside")!
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
  const aside = container.querySelector("aside")!
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
  const aside = container.querySelector("aside")!
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
  expect(container.querySelector("aside")!.className).toContain(expected)
})

test("never collapses the sheet variant, where the rail is the drawer's column", () => {
  const { container } = render(
    withTooltipProvider(
      <GuildRail variant="sheet" collapsed onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />
    )
  )
  const aside = container.querySelector("aside")!
  expect(aside).not.toHaveAttribute("data-collapsed")
  expect(aside.style.width).toBe("")
})

test("the sheet variant renders unconditionally on a phone viewport", () => {
  const { container } = render(
    withTooltipProvider(
      <GuildRail variant="sheet" onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />
    )
  )
  const aside = container.querySelector("aside")!
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
    expect(container.querySelector("aside")).toHaveAttribute("data-side", DEFAULT_SIDEBAR_SIDE)
  })

  test("borders against the workbench on the right, but not on the left", () => {
    setSide("right")
    const { container, rerender } = render(
      withTooltipProvider(<GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />)
    )
    // Both this rail and ContextWorkbench declare data-bg-target="sidebar", so
    // with a wallpaper on, tone alone leaves no seam between them.
    expect(container.querySelector("aside")!.className).toContain("border-l")

    setSide("left")
    rerender(withTooltipProvider(<GuildRail onCreateTeam={jest.fn()} onOpenSettings={jest.fn()} />))
    // Nothing to its left but the window edge — a border would draw the seam twice.
    expect(container.querySelector("aside")!.className).not.toContain("border-l")
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
    expect(container.querySelector("aside")).toHaveAttribute("data-side", "left")
    expect(container.querySelector("aside")!.className).not.toContain("border-l")
  })
})
