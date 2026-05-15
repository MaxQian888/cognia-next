/**
 * @jest-environment jsdom
 */
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { ChatSession } from "@/lib/claude/types"

import { MobileChannelList } from "./mobile-channel-list"

const updateSessionMock: jest.Mock<Promise<void>, [string, Record<string, unknown>]> = jest.fn()
jest.mock("@/lib/db/sessions", () => ({
  updateSession: (id: string, patch: Record<string, unknown>) => updateSessionMock(id, patch),
}))

const charactersRef: {
  value: Array<{ id: string; name: string; avatarColor?: string; avatarEmoji?: string }>
} = { value: [] }
jest.mock("@/lib/db/characters", () => ({
  listCharacters: () => charactersRef.value,
}))

const sessionStatesRef: {
  value: Array<{ sessionId: string; lastReadAt: number; unreadCount: number }>
} = { value: [] }
jest.mock("@/lib/db/session-state", () => ({
  listSessionStates: () => sessionStatesRef.value,
}))

jest.mock("@/hooks/data", () => ({
  // Synchronous wrapper: just invoke the query and return its value as-is
  // (the lib mocks above return values directly, not promises).
  useClientLiveQuery: <T,>(query: () => T) => query(),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    const map: Record<string, string> = {
      search: "Search",
      searchAria: "Search aria",
      pinned: "Pinned",
      recent: "Recent",
      emptyChats: "Empty",
      emptyFiltered: `No "${vars?.query ?? ""}"`,
      swipePin: "Pin",
      swipeUnpin: "Unpin",
      swipeDelete: "Delete",
      unreadCount: `${vars?.count ?? 0} unread`,
    }
    return map[key] ?? key
  },
}))

jest.mock("@/lib/capacitor/haptics", () => ({
  impact: () => Promise.resolve({ kind: "ok" }),
  selectionFeedback: () => Promise.resolve({ kind: "ok" }),
}))

const baseSession = (id: string, overrides: Partial<ChatSession> = {}): ChatSession => ({
  id,
  title: id,
  createdAt: 1,
  updatedAt: 1,
  kind: "direct",
  ...overrides,
})

const sessions: ChatSession[] = [
  baseSession("s1", { title: "Daily standup", pinned: true, updatedAt: 100 }),
  baseSession("s2", { title: "Octopus Tutor", updatedAt: 200 }),
  baseSession("s3", { title: "Side note", updatedAt: 50 }),
]

describe("<MobileChannelList />", () => {
  beforeEach(() => {
    updateSessionMock.mockReset()
    updateSessionMock.mockResolvedValue(undefined)
    charactersRef.value = []
    sessionStatesRef.value = []
  })

  it("groups pinned and recent sessions", () => {
    render(
      <MobileChannelList
        sessions={sessions}
        activeSessionId="s2"
        onSelect={jest.fn()}
        onNewDirect={jest.fn()}
        onDelete={jest.fn()}
      />
    )
    const pinned = screen.getByTestId("mobile-channel-pinned")
    const recent = screen.getByTestId("mobile-channel-recent")
    expect(within(pinned).getByText("Daily standup")).toBeInTheDocument()
    expect(within(recent).getByText("Octopus Tutor")).toBeInTheDocument()
    expect(within(recent).getByText("Side note")).toBeInTheDocument()
  })

  it("marks the active session", () => {
    render(
      <MobileChannelList
        sessions={sessions}
        activeSessionId="s2"
        onSelect={jest.fn()}
        onNewDirect={jest.fn()}
        onDelete={jest.fn()}
      />
    )
    expect(screen.getByTestId("mobile-channel-row-s2")).toHaveAttribute("data-active", "true")
    expect(screen.getByTestId("mobile-channel-row-s1")).toHaveAttribute("data-active", "false")
  })

  it("filters via the search box", async () => {
    const user = userEvent.setup()
    render(
      <MobileChannelList
        sessions={sessions}
        activeSessionId={null}
        onSelect={jest.fn()}
        onNewDirect={jest.fn()}
        onDelete={jest.fn()}
      />
    )
    await user.type(screen.getByTestId("mobile-channel-search"), "octopus")
    expect(screen.queryByTestId("mobile-channel-row-s1")).not.toBeInTheDocument()
    expect(screen.queryByTestId("mobile-channel-row-s3")).not.toBeInTheDocument()
    expect(screen.getByTestId("mobile-channel-row-s2")).toBeInTheDocument()
  })

  it("shows the filtered-empty copy when the query matches nothing", async () => {
    const user = userEvent.setup()
    render(
      <MobileChannelList
        sessions={sessions}
        activeSessionId={null}
        onSelect={jest.fn()}
        onNewDirect={jest.fn()}
        onDelete={jest.fn()}
      />
    )
    await user.type(screen.getByTestId("mobile-channel-search"), "zzz")
    expect(screen.getByTestId("mobile-channel-empty")).toHaveTextContent('No "zzz"')
  })

  it("invokes onSelect when a row is tapped", async () => {
    const onSelect = jest.fn()
    const user = userEvent.setup()
    render(
      <MobileChannelList
        sessions={sessions}
        activeSessionId={null}
        onSelect={onSelect}
        onNewDirect={jest.fn()}
        onDelete={jest.fn()}
      />
    )
    await user.click(screen.getByTestId("mobile-channel-row-s2"))
    expect(onSelect).toHaveBeenCalledWith("s2")
  })

  it("toggles pin via the swipe action", async () => {
    const user = userEvent.setup()
    render(
      <MobileChannelList
        sessions={sessions}
        activeSessionId={null}
        onSelect={jest.fn()}
        onNewDirect={jest.fn()}
        onDelete={jest.fn()}
      />
    )
    await user.click(screen.getAllByTestId("swipe-action-pin")[0])
    expect(updateSessionMock).toHaveBeenCalled()
    const [id, patch] = updateSessionMock.mock.calls[0]
    expect(id).toBe("s1")
    expect(patch).toMatchObject({ pinned: false })
  })

  it("calls onNewDirect from the + button", async () => {
    const onNewDirect = jest.fn()
    const user = userEvent.setup()
    render(
      <MobileChannelList
        sessions={sessions}
        activeSessionId={null}
        onSelect={jest.fn()}
        onNewDirect={onNewDirect}
        onDelete={jest.fn()}
      />
    )
    await user.click(screen.getByTestId("mobile-channel-new"))
    expect(onNewDirect).toHaveBeenCalled()
  })

  it("renders the global empty copy when no sessions exist", () => {
    render(
      <MobileChannelList
        sessions={[]}
        activeSessionId={null}
        onSelect={jest.fn()}
        onNewDirect={jest.fn()}
        onDelete={jest.fn()}
      />
    )
    expect(screen.getByTestId("mobile-channel-empty")).toHaveTextContent("Empty")
  })

  it("renders an unread red dot when sessionState.unreadCount > 0", () => {
    sessionStatesRef.value = [{ sessionId: "s2", lastReadAt: 0, unreadCount: 3 }]
    render(
      <MobileChannelList
        sessions={sessions}
        activeSessionId={null}
        onSelect={jest.fn()}
        onNewDirect={jest.fn()}
        onDelete={jest.fn()}
      />
    )
    expect(screen.getByTestId("mobile-channel-unread-s2")).toHaveAttribute("aria-label", "3 unread")
    expect(screen.queryByTestId("mobile-channel-unread-s1")).not.toBeInTheDocument()
  })

  it("resolves the avatar via the bound character when characterId matches", () => {
    charactersRef.value = [{ id: "ch1", name: "Octopus", avatarEmoji: "🐙", avatarColor: "#abc" }]
    const sessionsWithChar: ChatSession[] = [
      baseSession("s1", { title: "Daily standup", characterId: "ch1", updatedAt: 100 }),
    ]
    render(
      <MobileChannelList
        sessions={sessionsWithChar}
        activeSessionId={null}
        onSelect={jest.fn()}
        onNewDirect={jest.fn()}
        onDelete={jest.fn()}
      />
    )
    expect(screen.getByText("🐙")).toBeInTheDocument()
  })

  it("clears the search query via the X button", async () => {
    const user = userEvent.setup()
    render(
      <MobileChannelList
        sessions={sessions}
        activeSessionId={null}
        onSelect={jest.fn()}
        onNewDirect={jest.fn()}
        onDelete={jest.fn()}
      />
    )
    await user.type(screen.getByTestId("mobile-channel-search"), "abc")
    await user.click(screen.getByTestId("mobile-channel-search-clear"))
    expect(screen.getByTestId("mobile-channel-search")).toHaveValue("")
  })

  it("invokes onDelete via the swipe action", async () => {
    const onDelete = jest.fn()
    const user = userEvent.setup()
    render(
      <MobileChannelList
        sessions={sessions}
        activeSessionId={null}
        onSelect={jest.fn()}
        onNewDirect={jest.fn()}
        onDelete={onDelete}
      />
    )
    await user.click(screen.getAllByTestId("swipe-action-delete")[0])
    expect(onDelete).toHaveBeenCalled()
  })
})
