/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, act } from "@testing-library/react"
import { DndContext } from "@dnd-kit/core"
import { SortableContext } from "@dnd-kit/sortable"
import type { Team } from "@cognia/agent-config-types"
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
let guildUnread = { dm: 0, teams: new Map<string, number>(), total: 0 }
const markGuildRead = jest.fn(async (_target: unknown) => 1)
jest.mock("@/hooks/shell/use-guild-unread", () => ({
  useGuildUnread: () => guildUnread,
  markGuildRead: (target: unknown) => markGuildRead(target as never),
}))
jest.mock("@/components/desktop/avatar-badge", () => ({
  AvatarBadge: ({ subject }: { subject: { name: string } }) => (
    <span data-testid={`avatar-${subject.name}`} />
  ),
}))

import {
  SidebarCreateTeamRow,
  SidebarGuildSectionRows,
  activeGuildKey,
  guildSectionRows,
} from "./sidebar-guild-sections"

const team = (id: string, name: string): Team =>
  ({ id, name, memberIds: [], createdAt: new Date(), updatedAt: new Date() }) as unknown as Team
const teams = [team("t-1", "Alpha"), team("t-2", "Beta")]

beforeEach(() => {
  routerPush.mockReset()
  logInfo.mockReset()
  setSelectedGuild.mockClear()
  selectedGuild = { kind: "dm" }
  pathname = "/"
  guildUnread = { dm: 0, teams: new Map(), total: 0 }
  markGuildRead.mockClear()
  act(() => {
    useSettingsStore.setState({
      settings: { sidebarLayout: { ...DEFAULT_SIDEBAR_LAYOUT } } as never,
      save: jest.fn(async () => {}) as never,
    })
  })
})

describe("guildSectionRows", () => {
  it("puts Chats first, then the teams in the order given", () => {
    expect(guildSectionRows(teams).map((r) => r.key)).toEqual(["dm", "t-1", "t-2"])
  })

  it("carries each team on its row, so the caller never re-looks it up", () => {
    const [, alpha] = guildSectionRows(teams)
    expect(alpha).toEqual({ key: "t-1", team: teams[0] })
  })

  it("draws Chats even with no teams at all", () => {
    expect(guildSectionRows([]).map((r) => r.key)).toEqual(["dm"])
  })
})

describe("activeGuildKey", () => {
  it("names the selected scope", () => {
    expect(activeGuildKey({ kind: "dm" })).toBe("dm")
    expect(activeGuildKey({ kind: "team", teamId: "t-2" })).toBe("t-2")
  })

  it("keeps naming a team that is gone, so Chats is not falsely highlighted", () => {
    // The list is still scoped to that team's (now empty) set; highlighting
    // Chats would misname what is on screen.
    expect(activeGuildKey({ kind: "team", teamId: "t-9" })).toBe("t-9")
    expect(guildSectionRows(teams).some((r) => r.key === "t-9")).toBe(false)
  })
})

describe("SidebarGuildSectionRows", () => {
  it("renders every scope as a row, highlights the selected one, and switches on click", () => {
    selectedGuild = { kind: "team", teamId: "t-1" }
    render(<SidebarGuildSectionRows rows={guildSectionRows(teams)} activeKey="t-1" testId="rows" />)
    const dm = screen.getByTestId("sidebar-guild-dm")
    const alpha = screen.getByTestId("sidebar-guild-team-t-1")
    expect(dm).toHaveTextContent("directMessages")
    expect(alpha).toHaveTextContent("Alpha")
    expect(screen.getByTestId("avatar-Alpha")).toBeInTheDocument()
    // A scope, not a disclosure: the row is the current page, and nothing
    // about it claims to have opened a panel.
    expect(alpha).toHaveAttribute("aria-current", "page")
    expect(dm).not.toHaveAttribute("aria-current")
    expect(alpha).not.toHaveAttribute("aria-expanded")
    expect(alpha).not.toHaveAttribute("aria-controls")

    fireEvent.click(dm)
    expect(setSelectedGuild).toHaveBeenLastCalledWith({ kind: "dm" })
    expect(logInfo).toHaveBeenCalledWith("guild switch dm")
  })

  it("selecting a team switches to it (and routes home off `/`)", () => {
    pathname = "/inbox"
    render(<SidebarGuildSectionRows rows={guildSectionRows(teams)} activeKey="dm" />)
    fireEvent.click(screen.getByTestId("sidebar-guild-team-t-2"))
    expect(setSelectedGuild).toHaveBeenLastCalledWith({ kind: "team", teamId: "t-2" })
    expect(routerPush).toHaveBeenCalledWith("/")
  })

  it("keeps Chats on screen while a team is selected — it is the way back out", () => {
    render(<SidebarGuildSectionRows rows={guildSectionRows(teams)} activeKey="t-1" />)
    expect(screen.getByTestId("sidebar-guild-dm")).toBeInTheDocument()
    // ...and while Chats itself is the scope. The old accordion dropped this
    // row when Chats was open, because the list right below it *was* the
    // section; the group is a fixed block now, so a hole in it is just a hole.
    render(<SidebarGuildSectionRows rows={guildSectionRows(teams)} activeKey="dm" />)
    expect(screen.getAllByTestId("sidebar-guild-dm")).toHaveLength(2)
  })

  it("marks the selected row without turning it into a heading", () => {
    render(<SidebarGuildSectionRows rows={guildSectionRows(teams)} activeKey="t-1" />)
    expect(screen.getByTestId("sidebar-guild-team-t-1")).toHaveClass("font-medium")
    // No disclosure chevron anywhere — these rows never opened anything.
    expect(document.querySelector(".rotate-90")).toBeNull()
    // The list's actions are not on the row — they head the sidebar and sit on
    // the search row (`channel-list.tsx`).
    expect(screen.queryByTestId("sidebar-guild-open-actions")).toBeNull()
  })

  it("carries the unread count on unselected rows only, and names the row for truncated labels", () => {
    guildUnread = {
      dm: 4,
      teams: new Map([
        ["t-1", 2],
        ["t-2", 120],
      ]),
      total: 126,
    }
    render(<SidebarGuildSectionRows rows={guildSectionRows(teams)} activeKey="t-1" />)
    // Chats and Beta are off screen, so their rows say what is waiting; the
    // selected Alpha's conversations are the list itself (which carries
    // per-row badges), so no pill there.
    expect(screen.getByTestId("sidebar-guild-unread-dm")).toHaveTextContent("4")
    expect(screen.getByTestId("sidebar-guild-unread-t-2")).toHaveTextContent("99+")
    expect(screen.queryByTestId("sidebar-guild-unread-t-1")).toBeNull()
    // The full name is one hover away even when the row truncates it.
    expect(screen.getByTestId("sidebar-guild-team-t-2")).toHaveAttribute("title", "Beta")
    expect(screen.getByTestId("sidebar-guild-dm")).toHaveAttribute("title", "directMessages")
  })

  it("draws no pill for an unselected row without unread", () => {
    render(<SidebarGuildSectionRows rows={guildSectionRows(teams)} activeKey="dm" />)
    expect(screen.queryByTestId("sidebar-guild-unread-t-1")).toBeNull()
  })

  it("right-click: start a conversation in a scope without selecting it", () => {
    const onNewConversation = jest.fn()
    render(
      <SidebarGuildSectionRows
        rows={guildSectionRows(teams)}
        activeKey="dm"
        onNewConversation={onNewConversation}
      />
    )
    fireEvent.contextMenu(screen.getByTestId("sidebar-guild-team-t-2"))
    fireEvent.click(screen.getByTestId("sidebar-guild-menu-new-t-2"))
    expect(onNewConversation).toHaveBeenCalledWith("t-2")
    // The scope did not have to be selected first.
    expect(setSelectedGuild).not.toHaveBeenCalled()
  })

  it("right-click on Direct Messages offers a new chat (null team) and no team management", () => {
    const onNewConversation = jest.fn()
    render(
      <SidebarGuildSectionRows
        rows={[{ key: "dm" }]}
        activeKey="dm"
        onNewConversation={onNewConversation}
      />
    )
    fireEvent.contextMenu(screen.getByTestId("sidebar-guild-dm"))
    expect(screen.queryByTestId("sidebar-guild-menu-manage-dm")).toBeNull()
    fireEvent.click(screen.getByTestId("sidebar-guild-menu-new-dm"))
    expect(onNewConversation).toHaveBeenCalledWith(null)
  })

  it("right-click: mark a scope read (only when it has unread) and manage teams", () => {
    guildUnread = { dm: 0, teams: new Map([["t-1", 3]]), total: 3 }
    render(<SidebarGuildSectionRows rows={guildSectionRows(teams)} activeKey="dm" />)
    // No "new" item without a handler (the mobile Sheet has none to give).
    fireEvent.contextMenu(screen.getByTestId("sidebar-guild-team-t-2"))
    expect(screen.queryByTestId("sidebar-guild-menu-new-t-2")).toBeNull()
    expect(screen.getByTestId("sidebar-guild-menu-mark-read-t-2")).toHaveAttribute("data-disabled")
    fireEvent.click(screen.getByTestId("sidebar-guild-menu-manage-t-2"))
    expect(routerPush).toHaveBeenCalledWith("/settings?section=teams")

    fireEvent.contextMenu(screen.getByTestId("sidebar-guild-team-t-1"))
    const markRead = screen.getByTestId("sidebar-guild-menu-mark-read-t-1")
    expect(markRead).not.toHaveAttribute("data-disabled")
    fireEvent.click(markRead)
    expect(markGuildRead).toHaveBeenCalledWith({ kind: "team", teamId: "t-1" })
  })

  it("renders nothing for an empty run", () => {
    const { container } = render(<SidebarGuildSectionRows rows={[]} activeKey="dm" />)
    expect(container).toBeEmptyDOMElement()
  })

  it("right-click: moves a team up or down without selecting it", () => {
    const onMoveTeam = jest.fn()
    render(
      <SidebarGuildSectionRows
        rows={guildSectionRows(teams)}
        activeKey="dm"
        onMoveTeam={onMoveTeam}
      />
    )
    fireEvent.contextMenu(screen.getByTestId("sidebar-guild-team-t-2"))
    fireEvent.click(screen.getByTestId("sidebar-guild-menu-move-up-t-2"))
    expect(onMoveTeam).toHaveBeenLastCalledWith("t-2", -1)

    fireEvent.contextMenu(screen.getByTestId("sidebar-guild-team-t-1"))
    fireEvent.click(screen.getByTestId("sidebar-guild-menu-move-down-t-1"))
    expect(onMoveTeam).toHaveBeenLastCalledWith("t-1", 1)
    // Reordering never selects the scope it moves.
    expect(setSelectedGuild).not.toHaveBeenCalled()
  })

  it("offers no move items on Chats — it is not one of the teams", () => {
    render(<SidebarGuildSectionRows rows={[{ key: "dm" }]} activeKey="dm" onMoveTeam={jest.fn()} />)
    fireEvent.contextMenu(screen.getByTestId("sidebar-guild-dm"))
    expect(screen.queryByTestId("sidebar-guild-menu-move-up-dm")).toBeNull()
    expect(screen.queryByTestId("sidebar-guild-menu-move-down-dm")).toBeNull()
  })

  it("makes only the team rows draggable, and only inside a caller's DndContext", () => {
    const { rerender } = render(
      <SidebarGuildSectionRows rows={guildSectionRows(teams)} activeKey="dm" />
    )
    const row = () => screen.getByTestId("sidebar-guild-team-t-1").closest("[role=listitem]")
    // Off by default: the mobile Sheet renders these rows with no drag context.
    expect(row()).not.toHaveAttribute("aria-roledescription")

    rerender(
      <DndContext>
        <SortableContext items={["t-1", "t-2"]}>
          <SidebarGuildSectionRows rows={guildSectionRows(teams)} activeKey="dm" sortable />
        </SortableContext>
      </DndContext>
    )
    expect(row()).toHaveAttribute("aria-roledescription", "sortable")
    // dnd-kit's activator attributes must not steal the row's own focus
    // model — the sidebar runs one roving tab stop across every row.
    expect(row()).not.toHaveAttribute("tabindex")
    expect(row()).toHaveAttribute("role", "listitem")
  })

  it("leaves Chats out of the drag even when the run is sortable", () => {
    const rows = [{ key: "dm" as const }, { key: "t-1", team: teams[0] }]
    render(
      <DndContext>
        <SortableContext items={["t-1"]}>
          <SidebarGuildSectionRows rows={rows} activeKey="t-1" sortable />
        </SortableContext>
      </DndContext>
    )
    const listItem = (testId: string) => screen.getByTestId(testId).closest("[role=listitem]")
    expect(listItem("sidebar-guild-dm")).not.toHaveAttribute("aria-roledescription")
    expect(listItem("sidebar-guild-team-t-1")).toHaveAttribute("aria-roledescription", "sortable")
  })
})

describe("SidebarCreateTeamRow", () => {
  it("routes to the teams settings section", () => {
    render(<SidebarCreateTeamRow />)
    fireEvent.click(screen.getByTestId("sidebar-guild-create-team"))
    expect(routerPush).toHaveBeenCalledWith("/settings?section=teams")
    expect(logInfo).toHaveBeenCalledWith("guild create team click")
  })
})
