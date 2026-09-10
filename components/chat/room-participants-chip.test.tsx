/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({
  useTranslations: () => {
    const t = (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${JSON.stringify(values)}` : key
    t.has = () => true
    return t
  },
}))

let mockMembers: unknown[] = []
let mockRoles = new Map<string, string>()
jest.mock("@/hooks/use-team-members", () => ({
  useTeamMembers: () => mockMembers,
  useTeamMemberRoles: () => mockRoles,
}))

let mockMemberships: unknown[] = []
jest.mock("@/hooks/data", () => ({
  useClientLiveQuery: (loader: () => Promise<unknown>) =>
    loader.toString().includes("collabChatMemberships") ? mockMemberships : [],
}))

let mockMessages: unknown[] = []
jest.mock("@/stores/chat", () => ({
  useChatStore: (selector: (state: unknown) => unknown) =>
    selector({ sessions: { sess_1: { messages: mockMessages } } }),
}))

import type { Character, ChatSession } from "@cognia/agent-config-types"

import { useUIStore } from "@/stores/ui"
import { RoomParticipantsChip } from "./room-participants-chip"

function character(id: string, name: string): Character {
  return {
    id,
    name,
    avatarColor: "oklch(0.7 0 0)",
    systemPrompt: "",
    createdAt: 0,
    updatedAt: 0,
  } as Character
}

function session(overrides: Partial<ChatSession> = {}): ChatSession {
  return { id: "sess_1", title: "Room", ...overrides } as ChatSession
}

function imTurn(id: string, displayName: string) {
  return {
    role: "user",
    parts: [{ type: "text", text: "hi" }],
    metadata: { platformMessage: { sender: { id, displayName } } },
  }
}

beforeEach(() => {
  mockMembers = []
  mockRoles = new Map()
  mockMemberships = []
  mockMessages = []
})

describe("RoomParticipantsChip", () => {
  it("stays out of the way of a one-to-one conversation", () => {
    // A private chat has one counterpart, and a chip saying so is chrome that
    // tells the reader nothing they did not already know.
    mockMessages = [imTurn("tg:1", "Ana")]
    render(<RoomParticipantsChip session={session()} />)
    expect(screen.queryByTestId("room-participants-chip")).not.toBeInTheDocument()
  })

  it("counts a team's members before any of them has spoken", () => {
    // The declared side is the whole point: a member who has not answered yet
    // is still in the room and still addressable.
    mockMembers = [character("char_a", "Ana"), character("char_b", "Ben")]
    render(<RoomParticipantsChip session={session({ kind: "team", teamId: "team_1" })} />)
    expect(screen.getByTestId("room-participants-chip").textContent).toContain("2")
  })

  it("says what a busy member is doing, under its name (ADR-0177 batch 2)", async () => {
    mockMembers = [character("char_a", "Ana"), character("char_b", "Ben")]
    useUIStore.getState().setMemberActivity("sess_1", "char_a", "Bash · pnpm test")
    const user = userEvent.setup({ delay: null })
    render(<RoomParticipantsChip session={session({ kind: "team", teamId: "team_1" })} />)
    await user.click(screen.getByTestId("room-participants-chip"))
    expect(await screen.findByTestId("room-participant-activity-char_a")).toHaveTextContent(
      "Bash · pnpm test"
    )
    expect(screen.queryByTestId("room-participant-activity-char_b")).toBeNull()
    useUIStore.getState().clearMemberStatusFor("sess_1")
  })

  it("names everyone in the room, with their roles", async () => {
    mockMembers = [character("char_a", "Ana"), character("char_b", "Ben")]
    mockRoles = new Map([["char_a", "Researcher"]])
    const user = userEvent.setup({ delay: null })
    render(<RoomParticipantsChip session={session({ kind: "team", teamId: "team_1" })} />)

    await user.click(screen.getByTestId("room-participants-chip"))

    expect(await screen.findByText("Ana")).toBeInTheDocument()
    expect(screen.getByText("Ben")).toBeInTheDocument()
    expect(screen.getByText("Researcher")).toBeInTheDocument()
  })

  it("sees the people in an IM group, which declares no members at all", async () => {
    mockMessages = [imTurn("tg:1", "Ana"), imTurn("tg:2", "Ben"), imTurn("tg:3", "Cara")]
    const user = userEvent.setup({ delay: null })
    render(<RoomParticipantsChip session={session()} />)

    expect(screen.getByTestId("room-participants-chip").textContent).toContain("3")
    await user.click(screen.getByTestId("room-participants-chip"))
    expect(await screen.findByText("Cara")).toBeInTheDocument()
    expect(screen.getByText("Ana")).toBeInTheDocument()
  })

  it("counts a member that has spoken once, not twice", async () => {
    // The declared row and the message speaker are the same participant. They
    // are matched by id, which is also what lets the member keep its own
    // avatar instead of the colour its id happens to hash to.
    mockMembers = [character("char_a", "Ana"), character("char_b", "Ben")]
    mockMessages = [
      { role: "assistant", senderId: "char_a", parts: [{ type: "text", text: "hi" }] },
    ]
    const user = userEvent.setup({ delay: null })
    render(<RoomParticipantsChip session={session({ kind: "team", teamId: "team_1" })} />)

    expect(screen.getByTestId("room-participants-chip").textContent).toContain("2")
    await user.click(screen.getByTestId("room-participants-chip"))
    expect(screen.getAllByText("Ana")).toHaveLength(1)
  })

  it("never puts a display name the redaction gate rejected on screen", async () => {
    // Somebody whose IM nickname is their phone number. The prompt shows a
    // stable pseudonym for them, and so must the header.
    mockMessages = [imTurn("tg:1", "13800138000"), imTurn("tg:2", "Ben")]
    const user = userEvent.setup({ delay: null })
    render(<RoomParticipantsChip session={session()} />)

    await user.click(screen.getByTestId("room-participants-chip"))

    expect(await screen.findByText("Ben")).toBeInTheDocument()
    expect(screen.queryByText("13800138000")).not.toBeInTheDocument()
  })

  it("vouches for a team roster, and says an IM group's list is only who has spoken", async () => {
    const user = userEvent.setup({ delay: null })
    mockMembers = [character("char_a", "Ana"), character("char_b", "Ben")]
    const team = render(
      <RoomParticipantsChip session={session({ kind: "team", teamId: "team_1" })} />
    )
    await user.click(screen.getByTestId("room-participants-chip"))
    await screen.findByText("Ana")
    expect(screen.queryByTestId("room-participants-observed")).not.toBeInTheDocument()
    team.unmount()

    mockMembers = []
    mockMessages = [imTurn("tg:1", "Ana"), imTurn("tg:2", "Ben")]
    render(
      <RoomParticipantsChip
        session={session({ platformBinding: { platform: "telegram" } as never })}
      />
    )
    await user.click(screen.getByTestId("room-participants-chip"))
    expect(await screen.findByTestId("room-participants-observed")).toHaveTextContent(
      "observedOnly"
    )
  })

  it("reads a shared room's members from the collab mirror, guests included", async () => {
    mockMemberships = [
      { userId: "usr_1", role: "owner", guest: false, displayName: "Ana" },
      { userId: "usr_2", role: "member", guest: true, displayName: "Guest Ben" },
    ]
    const user = userEvent.setup({ delay: null })
    render(<RoomParticipantsChip session={session({ collaboration: {} as never })} />)
    expect(screen.getByTestId("room-participants-chip").textContent).toContain("2")
    await user.click(screen.getByTestId("room-participants-chip"))
    expect(await screen.findByText("Ana")).toBeInTheDocument()
    expect(screen.getByText("Guest Ben")).toBeInTheDocument()
    expect(screen.getByText("owner")).toBeInTheDocument()
    expect(screen.queryByTestId("room-participants-observed")).not.toBeInTheDocument()
  })
})
