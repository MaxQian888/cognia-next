import { useState } from "react"
import { act, fireEvent, render, screen, within } from "@testing-library/react"
import type { Character, ChatSession, Team } from "@cognia/agent-config-types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => `t:${key}`,
}))

let team: Team | undefined
let session: ChatSession | undefined
const members: Character[] = [
  { id: "ava", name: "Ava" } as Character,
  { id: "bee", name: "Bee" } as Character,
]
jest.mock("@/hooks/data", () => ({
  useClientLiveQuery: (loader: () => Promise<unknown>) => {
    const source = loader.toString()
    if (source.includes("getTeam")) return team
    if (source.includes("getSession")) return session
    return undefined
  },
}))
jest.mock("@/hooks/use-team-members", () => ({
  useTeamMembers: (teamId: string | null) => (teamId ? members : []),
  useTeamMemberRoles: () => new Map([["bee", "Researcher"]]),
}))
jest.mock("@/lib/db/teams", () => ({ getTeam: jest.fn() }))
jest.mock("@/lib/db/sessions", () => ({ getSession: jest.fn() }))
jest.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children, ...rest }: { children: React.ReactNode }) => (
    <div {...rest}>{children}</div>
  ),
}))

import { useRoomTargetStore } from "@/stores/chat/room-target-store"
import { ComposerSessionProvider } from "./composer-session-context"
import { ComposerMenuPanelsProvider, type ComposerMenuPanels } from "./composer-menu-context"
import {
  ROOM_TARGET_MENU_PANEL_ID,
  RoomTargetChip,
  RoomTargetPicker,
  roomReplyHint,
} from "./room-target-picker"

beforeEach(() => {
  useRoomTargetStore.setState({ targets: {} })
  team = { id: "t1", orchestration: "manual", members: [] } as unknown as Team
  session = { id: "s1", kind: "team", teamId: "t1" } as ChatSession
})

describe("roomReplyHint", () => {
  it("mirrors the router's hold reasons for what the composer can know", () => {
    expect(roomReplyHint({ orchestration: "manual", replyMode: "auto", pickedCount: 0 })).toBe(
      "manual"
    )
    expect(roomReplyHint({ orchestration: "manual", replyMode: "auto", pickedCount: 1 })).toBeNull()
    expect(
      roomReplyHint({ orchestration: "round_robin", replyMode: "mention_only", pickedCount: 0 })
    ).toBe("mention_only")
    expect(
      roomReplyHint({ orchestration: "round_robin", replyMode: "asleep", pickedCount: 2 })
    ).toBe("asleep")
    expect(
      roomReplyHint({ orchestration: "round_robin", replyMode: "auto", pickedCount: 0 })
    ).toBeNull()
  })
})

describe("RoomTargetPicker", () => {
  it("renders nothing outside a team room", () => {
    render(<RoomTargetPicker session={{ id: "d", kind: "direct" } as ChatSession} />)
    expect(screen.queryByTestId("composer-room-target-trigger")).toBeNull()
  })

  it("ticks members into the pick, marks muted ones, and clears", () => {
    session = { ...session!, roomSettings: { mutedMemberIds: ["bee"] } } as ChatSession
    render(<RoomTargetPicker session={session} />)
    expect(screen.getByTestId("composer-room-target-trigger")).not.toHaveAttribute("data-picked")
    fireEvent.click(screen.getByTestId("composer-room-target-bee"))
    fireEvent.click(screen.getByTestId("composer-room-target-ava"))
    expect(useRoomTargetStore.getState().targets.s1).toEqual(["bee", "ava"])
    expect(screen.getByTestId("composer-room-target-bee")).toHaveAttribute("aria-checked", "true")
    expect(screen.getByTestId("composer-room-target-muted-bee")).toHaveTextContent("t:muted")
    expect(screen.getByTestId("composer-room-target-bee")).toHaveTextContent("Researcher")
    expect(screen.getByTestId("composer-room-target-trigger")).toHaveAttribute("data-picked", "2")
    fireEvent.click(screen.getByTestId("composer-room-target-clear"))
    expect(useRoomTargetStore.getState().targets.s1).toBeUndefined()
  })

  it("is disabled while the room is asleep, with the reason as its title", () => {
    session = { ...session!, roomSettings: { replyMode: "asleep" } } as ChatSession
    render(<RoomTargetPicker session={session} />)
    const trigger = screen.getByTestId("composer-room-target-trigger")
    expect(trigger).toBeDisabled()
    expect(trigger).toHaveAttribute("title", "t:asleepDisabled")
  })
})

describe("RoomTargetChip", () => {
  const renderChip = () =>
    render(
      <ComposerSessionProvider value="s1">
        <RoomTargetChip bare />
      </ComposerSessionProvider>
    )

  it("says why a manual team may stay quiet, then names the pick once there is one", () => {
    renderChip()
    expect(screen.getByTestId("composer-room-hint")).toHaveAttribute("data-hint", "manual")
    act(() => useRoomTargetStore.getState().setTargets("s1", ["bee", "ava"]))
    expect(screen.getByTestId("composer-room-target-chip")).toHaveTextContent("Bee, Ava")
    fireEvent.click(screen.getByTestId("composer-room-target-chip-clear"))
    expect(screen.queryByTestId("composer-room-target-chip")).toBeNull()
    expect(screen.getByTestId("composer-room-hint")).toBeInTheDocument()
  })

  it("keeps the asleep hint even over a pick, and stays silent for an auto room", () => {
    session = { ...session!, roomSettings: { replyMode: "asleep" } } as ChatSession
    useRoomTargetStore.getState().setTargets("s1", ["ava"])
    const { unmount } = renderChip()
    expect(screen.queryByTestId("composer-room-target-chip")).toBeNull()
    expect(screen.getByTestId("composer-room-hint")).toHaveAttribute("data-hint", "asleep")
    unmount()

    useRoomTargetStore.setState({ targets: {} })
    session = { id: "s1", kind: "team", teamId: "t1" } as ChatSession
    team = { id: "t1", orchestration: "round_robin", members: [] } as unknown as Team
    renderChip()
    expect(screen.queryByTestId("composer-room-hint")).toBeNull()
    expect(screen.queryByTestId("composer-room-target-chip")).toBeNull()
  })

  it("renders nothing outside a team room", () => {
    session = { id: "s1", kind: "direct" } as ChatSession
    renderChip()
    expect(screen.queryByTestId("composer-room-hint")).toBeNull()
  })
})

/** A minimal drill-in host standing in for the mobile `+` sheet. */
function SheetHost({
  children,
  registerPanel = () => () => {},
}: {
  children: React.ReactNode
  registerPanel?: (id: string) => () => void
}) {
  const [active, setActive] = useState<{ id: string; title: string } | null>(null)
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  const panels: ComposerMenuPanels = {
    activePanelId: active?.id ?? null,
    slot,
    openPanel: (id, title) => setActive({ id, title }),
    closePanel: () => setActive(null),
    registerPanel,
  }
  return (
    <ComposerMenuPanelsProvider value={panels}>
      {children}
      <p data-testid="sheet-title">{active?.title ?? ""}</p>
      <div data-testid="sheet-slot" ref={setSlot} />
    </ComposerMenuPanelsProvider>
  )
}

describe("RoomTargetPicker inside the mobile sheet", () => {
  it("drills the sheet in to the member list instead of floating a popover", () => {
    render(
      <SheetHost>
        <RoomTargetPicker session={session} />
      </SheetHost>
    )
    expect(screen.queryByTestId("composer-room-target-panel")).toBeNull()
    fireEvent.click(screen.getByTestId("composer-room-target-trigger"))
    expect(screen.queryByTestId("composer-room-target-menu")).toBeNull()
    const slot = screen.getByTestId("sheet-slot")
    expect(within(slot).getByTestId("composer-room-target-panel")).toBeInTheDocument()
    // The sheet's header carries the title; the panel draws no heading of its own.
    expect(screen.getByTestId("sheet-title")).toHaveTextContent("t:title")
    expect(within(slot).queryByText("t:title")).toBeNull()
    expect(screen.getByTestId("composer-room-target-trigger")).toHaveAttribute(
      "aria-expanded",
      "true"
    )
  })

  it("ticks members with thumb-sized rows and clears, writing the same store", () => {
    render(
      <SheetHost>
        <RoomTargetPicker session={session} />
      </SheetHost>
    )
    fireEvent.click(screen.getByTestId("composer-room-target-trigger"))
    const row = screen.getByTestId("composer-room-target-ava")
    expect(row.className).toContain("touch-target")
    fireEvent.click(row)
    expect(useRoomTargetStore.getState().targets.s1).toEqual(["ava"])
    expect(row).toHaveAttribute("aria-checked", "true")
    expect(screen.getByTestId("composer-room-target-clear").className).toContain("touch-target")
    fireEvent.click(screen.getByTestId("composer-room-target-clear"))
    expect(useRoomTargetStore.getState().targets.s1).toBeUndefined()
  })

  it("offers no panel while the room is asleep", () => {
    session = { ...session!, roomSettings: { replyMode: "asleep" } } as ChatSession
    const registerPanel = jest.fn(() => () => {})
    render(
      <SheetHost registerPanel={registerPanel}>
        <RoomTargetPicker session={session} />
      </SheetHost>
    )
    expect(screen.getByTestId("composer-room-target-trigger")).toBeDisabled()
    expect(registerPanel).not.toHaveBeenCalled()
    expect(ROOM_TARGET_MENU_PANEL_ID).toBe("room-targets")
  })
})
