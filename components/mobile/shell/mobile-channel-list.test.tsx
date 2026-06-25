/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor, within } from "@testing-library/react"
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
  // Wave 4 / ADR-0026 — same synchronous shortcut for the Dexie-first hook.
  // We deliberately skip kicking the orchestrator in unit tests.
  useDexieFirstQuery: <T,>(opts: { query: () => T }) => ({
    data: opts.query(),
    isSyncing: false,
    lastSyncedAt: null,
    error: null,
  }),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    const map: Record<string, string> = {
      search: "Search",
      searchAria: "Search aria",
      pinned: "Pinned",
      recent: "Recent",
      bucketToday: "Today",
      bucketYesterday: "Yesterday",
      bucketPrev7: "Previous 7 Days",
      bucketPrev30: "Previous 30 Days",
      bucketOlder: "Older",
      renameAria: "Rename",
      emptyChats: "Empty",
      emptyFiltered: `No "${vars?.query ?? ""}"`,
      swipePin: "Pin",
      swipeUnpin: "Unpin",
      swipeDelete: "Delete",
      swipeArchive: "Archive",
      swipeUnarchive: "Unarchive",
      viewActive: "Show active",
      viewArchived: "Show archived",
      emptyArchived: "No archived",
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

  it("groups pinned sessions and buckets the rest by date", () => {
    render(
      <MobileChannelList
        sessions={sessions}
        activeSessionId="s2"
        onSelect={jest.fn()}
        onNewDirect={jest.fn()}
        onDelete={jest.fn()}
        onRename={jest.fn()}
        onArchive={jest.fn()}
        onUnarchive={jest.fn()}
      />
    )
    const pinned = screen.getByTestId("mobile-channel-pinned")
    // updatedAt values are epoch-tiny → the non-pinned sessions land in "Older".
    const older = screen.getByTestId("mobile-channel-bucket-older")
    expect(within(pinned).getByText("Daily standup")).toBeInTheDocument()
    expect(within(older).getByText("Octopus Tutor")).toBeInTheDocument()
    expect(within(older).getByText("Side note")).toBeInTheDocument()
    // The pinned session is not duplicated into the date bucket.
    expect(within(older).queryByText("Daily standup")).toBeNull()
  })

  it("renames a session via long-press inline edit", async () => {
    const onRename = jest.fn()
    const user = userEvent.setup()
    render(
      <MobileChannelList
        sessions={sessions}
        activeSessionId={null}
        onSelect={jest.fn()}
        onNewDirect={jest.fn()}
        onDelete={jest.fn()}
        onRename={onRename}
        onArchive={jest.fn()}
        onUnarchive={jest.fn()}
      />
    )
    // Long-press opens the inline rename input for that row.
    const row = screen.getByTestId("mobile-channel-row-s2")
    await user.pointer({ keys: "[TouchA>]", target: row })
    const input = await screen.findByTestId("mobile-channel-rename-s2")
    await user.clear(input)
    await user.type(input, "Renamed{Enter}")
    expect(onRename).toHaveBeenCalledWith("s2", "Renamed")
  })

  it("marks the active session", () => {
    render(
      <MobileChannelList
        sessions={sessions}
        activeSessionId="s2"
        onSelect={jest.fn()}
        onNewDirect={jest.fn()}
        onDelete={jest.fn()}
        onRename={jest.fn()}
        onArchive={jest.fn()}
        onUnarchive={jest.fn()}
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
        onRename={jest.fn()}
        onArchive={jest.fn()}
        onUnarchive={jest.fn()}
      />
    )
    await user.type(screen.getByTestId("mobile-channel-search"), "octopus")
    // The value fed to the grouping model is debounced (150ms), so the field
    // value updates immediately but the filtered result settles a tick later.
    await waitFor(() =>
      expect(screen.queryByTestId("mobile-channel-row-s1")).not.toBeInTheDocument()
    )
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
        onRename={jest.fn()}
        onArchive={jest.fn()}
        onUnarchive={jest.fn()}
      />
    )
    await user.type(screen.getByTestId("mobile-channel-search"), "zzz")
    // Debounced filter (150ms) before the empty-state copy appears.
    await waitFor(() =>
      expect(screen.getByTestId("mobile-channel-empty")).toHaveTextContent('No "zzz"')
    )
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
        onRename={jest.fn()}
        onArchive={jest.fn()}
        onUnarchive={jest.fn()}
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
        onRename={jest.fn()}
        onArchive={jest.fn()}
        onUnarchive={jest.fn()}
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
        onRename={jest.fn()}
        onArchive={jest.fn()}
        onUnarchive={jest.fn()}
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
        onRename={jest.fn()}
        onArchive={jest.fn()}
        onUnarchive={jest.fn()}
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
        onRename={jest.fn()}
        onArchive={jest.fn()}
        onUnarchive={jest.fn()}
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
        onRename={jest.fn()}
        onArchive={jest.fn()}
        onUnarchive={jest.fn()}
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
        onRename={jest.fn()}
        onArchive={jest.fn()}
        onUnarchive={jest.fn()}
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
        onRename={jest.fn()}
        onArchive={jest.fn()}
        onUnarchive={jest.fn()}
      />
    )
    await user.click(screen.getAllByTestId("swipe-action-delete")[0])
    expect(onDelete).toHaveBeenCalled()
  })

  it("renders a collapsible folder section for foldered sessions", async () => {
    const folders = [
      { id: "f1", name: "Work", projectId: "p", order: 0, createdAt: 0, updatedAt: 0 },
    ] as never
    const foldered: ChatSession[] = [
      baseSession("s1", { title: "Inside work", folderId: "f1", updatedAt: 100 }),
    ]
    const user = userEvent.setup()
    render(
      <MobileChannelList
        sessions={foldered}
        activeSessionId={null}
        onSelect={jest.fn()}
        onNewDirect={jest.fn()}
        onDelete={jest.fn()}
        onRename={jest.fn()}
        onArchive={jest.fn()}
        onUnarchive={jest.fn()}
        folders={folders}
      />
    )
    const folderSection = screen.getByTestId("mobile-channel-folder-f1")
    expect(within(folderSection).getByText("Inside work")).toBeInTheDocument()
    // Tapping the folder header collapses it, hiding its rows.
    await user.click(screen.getByRole("button", { name: "Work" }))
    expect(screen.queryByTestId("mobile-channel-row-s1")).not.toBeInTheDocument()
  })

  it("archives a session via the swipe action", async () => {
    const onArchive = jest.fn()
    const user = userEvent.setup()
    render(
      <MobileChannelList
        sessions={sessions}
        activeSessionId={null}
        onSelect={jest.fn()}
        onNewDirect={jest.fn()}
        onDelete={jest.fn()}
        onRename={jest.fn()}
        onArchive={onArchive}
        onUnarchive={jest.fn()}
      />
    )
    await user.click(screen.getAllByTestId("swipe-action-archive")[0])
    expect(onArchive).toHaveBeenCalled()
  })

  it("toggles to the archived view and unarchives via swipe", async () => {
    const onUnarchive = jest.fn()
    const archivedSessions: ChatSession[] = [
      baseSession("a1", { title: "Archived chat", archivedAt: 5, updatedAt: 10 }),
    ]
    const user = userEvent.setup()
    render(
      <MobileChannelList
        sessions={archivedSessions}
        activeSessionId={null}
        onSelect={jest.fn()}
        onNewDirect={jest.fn()}
        onDelete={jest.fn()}
        onRename={jest.fn()}
        onArchive={jest.fn()}
        onUnarchive={onUnarchive}
      />
    )
    // Active view hides the archived session; the empty state shows.
    expect(screen.queryByTestId("mobile-channel-row-a1")).not.toBeInTheDocument()
    await user.click(screen.getByTestId("mobile-channel-view-toggle"))
    // Archived view reveals it; swipe-archive now restores it.
    expect(screen.getByTestId("mobile-channel-row-a1")).toBeInTheDocument()
    await user.click(screen.getAllByTestId("swipe-action-archive")[0])
    expect(onUnarchive).toHaveBeenCalledWith("a1")
  })
})
