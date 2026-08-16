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
    expect(dm.before.map((r) => r.key)).toEqual(["dm"])
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

  it("shows the archived suffix on the open row only", () => {
    const { before } = splitGuildSections(teams, { kind: "team", teamId: "t-1" })
    render(<SidebarGuildSectionRows rows={before} openKey="t-1" archived />)
    expect(screen.getAllByTestId("channel-list-archived-suffix")).toHaveLength(1)
    expect(screen.getByTestId("sidebar-guild-team-t-1")).toHaveTextContent("archivedTitleSuffix")
    expect(screen.getByTestId("sidebar-guild-dm")).not.toHaveTextContent("archivedTitleSuffix")
  })

  it("draws the open section's actions beside its heading only, and no selection tint", () => {
    const { before } = splitGuildSections(teams, { kind: "team", teamId: "t-1" })
    render(
      <SidebarGuildSectionRows
        rows={before}
        openKey="t-1"
        openActions={<button data-testid="open-action">+</button>}
      />
    )
    const actions = screen.getByTestId("sidebar-guild-open-actions")
    expect(actions).toContainElement(screen.getByTestId("open-action"))
    // Beside the open row (its listitem), not inside the button, not on DM.
    const openItem = screen.getByTestId("sidebar-guild-team-t-1").closest('[role="listitem"]')
    expect(openItem).toContainElement(actions)
    expect(screen.getByTestId("sidebar-guild-team-t-1")).not.toContainElement(actions)
    expect(
      screen.getByTestId("sidebar-guild-dm").closest('[role="listitem"]')
    ).not.toContainElement(actions)
    // The open row is a heading: bold, no traveling highlight, chevron turned.
    expect(screen.getByTestId("sidebar-guild-team-t-1")).toHaveClass("font-medium")
    expect(screen.getByTestId("sidebar-guild-team-t-1").querySelector(".rotate-90")).not.toBeNull()
    expect(screen.getByTestId("sidebar-guild-dm").querySelector(".rotate-90")).toBeNull()
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
