/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, act } from "@testing-library/react"
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
  splitGuildSections,
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

describe("splitGuildSections", () => {
  it("puts DM first and cuts the accordion right after the open section", () => {
    const dm = splitGuildSections(teams, { kind: "dm" })
    expect(dm.openKey).toBe("dm")
    // Open Chats draws no row at all — the search field and the list below
    // are the section, so nothing goes above them.
    expect(dm.before).toEqual([])
    expect(dm.after.map((r) => r.key)).toEqual(["t-1", "t-2"])

    const mid = splitGuildSections(teams, { kind: "team", teamId: "t-1" })
    expect(mid.before.map((r) => r.key)).toEqual(["dm", "t-1"])
    expect(mid.after.map((r) => r.key)).toEqual(["t-2"])

    const last = splitGuildSections(teams, { kind: "team", teamId: "t-2" })
    expect(last.before.map((r) => r.key)).toEqual(["dm", "t-1", "t-2"])
    expect(last.after).toEqual([])
  })

  it("leaves nothing open when the selected team is gone", () => {
    const gone = splitGuildSections(teams, { kind: "team", teamId: "t-9" })
    expect(gone.openKey).toBeNull()
    expect(gone.before.map((r) => r.key)).toEqual(["dm", "t-1", "t-2"])
    expect(gone.after).toEqual([])
  })
})

describe("SidebarGuildSectionRows", () => {
  it("renders header rows, marks the open one expanded, and switches guilds on click", () => {
    selectedGuild = { kind: "team", teamId: "t-1" }
    const { before } = splitGuildSections(teams, selectedGuild)
    render(<SidebarGuildSectionRows rows={before} openKey="t-1" testId="rows" />)
    const dm = screen.getByTestId("sidebar-guild-dm")
    const alpha = screen.getByTestId("sidebar-guild-team-t-1")
    expect(dm).toHaveTextContent("directMessages")
    expect(dm).toHaveAttribute("aria-expanded", "false")
    expect(alpha).toHaveTextContent("Alpha")
    expect(alpha).toHaveAttribute("aria-expanded", "true")
    expect(alpha).not.toHaveAttribute("aria-current")
    expect(screen.getByTestId("avatar-Alpha")).toBeInTheDocument()

    fireEvent.click(dm)
    expect(setSelectedGuild).toHaveBeenLastCalledWith({ kind: "dm" })
    expect(logInfo).toHaveBeenCalledWith("guild switch dm")
  })

  it("selecting a closed team section switches to that team (and routes home off `/`)", () => {
    pathname = "/inbox"
    const { after } = splitGuildSections(teams, { kind: "dm" })
    render(<SidebarGuildSectionRows rows={after} openKey="dm" />)
    fireEvent.click(screen.getByTestId("sidebar-guild-team-t-2"))
    expect(setSelectedGuild).toHaveBeenLastCalledWith({ kind: "team", teamId: "t-2" })
    expect(routerPush).toHaveBeenCalledWith("/")
  })

  it("never draws a row for an open Chats section", () => {
    // The list itself is that section; a heading above it says nothing the
    // search field and the conversations below do not already say.
    const { before, after } = splitGuildSections(teams, { kind: "dm" })
    const { container } = render(<SidebarGuildSectionRows rows={before} openKey="dm" />)
    expect(container).toBeEmptyDOMElement()
    // Closed — the way back out of a team — it is a row like any other.
    render(<SidebarGuildSectionRows rows={after} openKey="t-1" />)
    expect(screen.queryByTestId("sidebar-guild-dm")).toBeNull()
    expect(screen.getByTestId("sidebar-guild-team-t-1")).toBeInTheDocument()
  })

  it("marks the open row as a heading: bold, no selection tint, chevron turned", () => {
    const { before } = splitGuildSections(teams, { kind: "team", teamId: "t-1" })
    render(<SidebarGuildSectionRows rows={before} openKey="t-1" />)
    expect(screen.getByTestId("sidebar-guild-team-t-1")).toHaveClass("font-medium")
    expect(screen.getByTestId("sidebar-guild-team-t-1").querySelector(".rotate-90")).not.toBeNull()
    expect(screen.getByTestId("sidebar-guild-dm").querySelector(".rotate-90")).toBeNull()
    // The list's actions are not on the heading — they head the sidebar and
    // sit on the search row (`channel-list.tsx`).
    expect(screen.queryByTestId("sidebar-guild-open-actions")).toBeNull()
  })

  it("carries the unread count on closed rows only, and names the row for truncated labels", () => {
    guildUnread = {
      dm: 4,
      teams: new Map([
        ["t-1", 2],
        ["t-2", 120],
      ]),
      total: 126,
    }
    const { before, after } = splitGuildSections(teams, { kind: "team", teamId: "t-1" })
    render(
      <>
        <SidebarGuildSectionRows rows={before} openKey="t-1" />
        <SidebarGuildSectionRows rows={after} openKey="t-1" />
      </>
    )
    // Closed DM and closed Beta show their pills; the open Alpha shows its
    // list instead (which carries per-row badges), so no pill there.
    expect(screen.getByTestId("sidebar-guild-unread-dm")).toHaveTextContent("4")
    expect(screen.getByTestId("sidebar-guild-unread-t-2")).toHaveTextContent("99+")
    expect(screen.queryByTestId("sidebar-guild-unread-t-1")).toBeNull()
    // The full name is one hover away even when the row truncates it.
    expect(screen.getByTestId("sidebar-guild-team-t-2")).toHaveAttribute("title", "Beta")
    expect(screen.getByTestId("sidebar-guild-dm")).toHaveAttribute("title", "directMessages")
  })

  it("draws no pill for a closed row without unread", () => {
    const { after } = splitGuildSections(teams, { kind: "dm" })
    render(<SidebarGuildSectionRows rows={after} openKey="dm" />)
    expect(screen.queryByTestId("sidebar-guild-unread-t-1")).toBeNull()
  })

  it("right-click: start a conversation in a closed section without opening it", () => {
    const onNewConversation = jest.fn()
    const { after } = splitGuildSections(teams, { kind: "dm" })
    render(
      <SidebarGuildSectionRows rows={after} openKey="dm" onNewConversation={onNewConversation} />
    )
    fireEvent.contextMenu(screen.getByTestId("sidebar-guild-team-t-2"))
    fireEvent.click(screen.getByTestId("sidebar-guild-menu-new-t-2"))
    expect(onNewConversation).toHaveBeenCalledWith("t-2")
    // The section did not have to open first.
    expect(setSelectedGuild).not.toHaveBeenCalled()
  })

  it("right-click on Direct Messages offers a new chat (null team) and no team management", () => {
    const onNewConversation = jest.fn()
    render(
      <SidebarGuildSectionRows
        rows={[{ key: "dm" }]}
        openKey="dm"
        onNewConversation={onNewConversation}
      />
    )
    fireEvent.contextMenu(screen.getByTestId("sidebar-guild-dm"))
    expect(screen.queryByTestId("sidebar-guild-menu-manage-dm")).toBeNull()
    fireEvent.click(screen.getByTestId("sidebar-guild-menu-new-dm"))
    expect(onNewConversation).toHaveBeenCalledWith(null)
  })

  it("right-click: mark a section read (only when it has unread) and manage teams", () => {
    guildUnread = { dm: 0, teams: new Map([["t-1", 3]]), total: 3 }
    const { after } = splitGuildSections(teams, { kind: "dm" })
    render(<SidebarGuildSectionRows rows={after} openKey="dm" />)
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
    const { container } = render(<SidebarGuildSectionRows rows={[]} openKey="dm" />)
    expect(container).toBeEmptyDOMElement()
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
