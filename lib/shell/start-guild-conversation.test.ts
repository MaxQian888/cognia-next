import type { ChatSession } from "@cognia/agent-config-types"

const mockStartNewSession = jest.fn()
const mockSetActiveSession = jest.fn()
const mockSetSelectedGuild = jest.fn()
const mockEmitSystemBusEvent = jest.fn()

const mockListScopedSessions = jest.fn()

jest.mock("@/lib/chat/start-session", () => ({
  startNewSession: (...args: unknown[]) => mockStartNewSession(...args),
}))

jest.mock("@/lib/db/sessions", () => ({
  listScopedSessions: (...args: unknown[]) => mockListScopedSessions(...args),
}))

jest.mock("@/stores/chat", () => ({
  useChatStore: {
    getState: () => ({ setActiveSession: mockSetActiveSession }),
  },
}))

jest.mock("@/stores/ui", () => ({
  useUIStore: {
    getState: () => ({ setSelectedGuild: mockSetSelectedGuild }),
  },
}))

jest.mock("@/lib/plugin/messaging/message-bus", () => ({
  emitSystemBusEvent: (...args: unknown[]) => mockEmitSystemBusEvent(...args),
  SystemEvents: { SESSION_SWITCHED: "session.switched" },
}))

jest.mock("@cognia/logging", () => ({
  loggers: { ui: { info: jest.fn() } },
}))

import { openCharacterChat, startGuildConversation } from "./start-guild-conversation"

describe("startGuildConversation", () => {
  const session = { id: "session-1" } as ChatSession

  beforeEach(() => {
    mockStartNewSession.mockReset().mockResolvedValue(session)
    mockSetActiveSession.mockReset()
    mockSetSelectedGuild.mockReset()
    mockEmitSystemBusEvent.mockReset()
    mockListScopedSessions.mockReset().mockResolvedValue([])
  })

  it("starts a team conversation with its caller-localized title", async () => {
    const navigate = jest.fn()

    await expect(
      startGuildConversation({
        teamId: "team-1",
        teamTitle: "新建会话",
        navigate,
        pathname: "/inbox",
      })
    ).resolves.toBe(session)

    expect(mockSetSelectedGuild).toHaveBeenCalledWith({ kind: "team", teamId: "team-1" })
    expect(mockStartNewSession).toHaveBeenCalledWith({
      title: "新建会话",
      kind: "team",
      teamId: "team-1",
    })
    expect(mockSetActiveSession).toHaveBeenCalledWith("session-1")
    expect(mockEmitSystemBusEvent).toHaveBeenCalledWith("session.switched", {
      sessionId: "session-1",
    })
    expect(navigate).toHaveBeenCalledWith("/")
  })

  it("refuses to persist a team conversation without a localized title", async () => {
    await expect(startGuildConversation({ teamId: "team-1" } as never)).rejects.toThrow(
      "teamTitle is required for team conversations"
    )

    expect(mockStartNewSession).not.toHaveBeenCalled()
  })

  it("starts a direct conversation without forcing a title or redundant navigation", async () => {
    const navigate = jest.fn()

    await startGuildConversation({ navigate, pathname: "/" })

    expect(mockSetSelectedGuild).toHaveBeenCalledWith({ kind: "dm" })
    expect(mockStartNewSession).toHaveBeenCalledWith(undefined)
    expect(navigate).not.toHaveBeenCalled()
  })
})

describe("openCharacterChat", () => {
  const character = { id: "char-1", name: "Research Analyst" }

  beforeEach(() => {
    mockStartNewSession.mockReset().mockResolvedValue({ id: "created-1" } as ChatSession)
    mockSetActiveSession.mockReset()
    mockSetSelectedGuild.mockReset()
    mockEmitSystemBusEvent.mockReset()
    mockListScopedSessions.mockReset().mockResolvedValue([])
  })

  it("switches to the newest direct conversation the character already has", async () => {
    const navigate = jest.fn()
    mockListScopedSessions.mockResolvedValue([
      { id: "other", kind: "direct", characterId: "char-2" },
      // A team conversation the character sits in is not their own chat.
      { id: "team", kind: "team", characterId: "char-1" },
      { id: "newest", kind: "direct", characterId: "char-1" },
      { id: "older", kind: "direct", characterId: "char-1" },
    ] as ChatSession[])

    await expect(
      openCharacterChat(character, {
        newChatTitle: "Chat with Research Analyst",
        navigate,
        pathname: "/inbox",
      })
    ).resolves.toMatchObject({ id: "newest" })

    expect(mockStartNewSession).not.toHaveBeenCalled()
    expect(mockSetSelectedGuild).toHaveBeenCalledWith({ kind: "dm" })
    expect(mockSetActiveSession).toHaveBeenCalledWith("newest")
    expect(mockEmitSystemBusEvent).toHaveBeenCalledWith("session.switched", {
      sessionId: "newest",
    })
    expect(navigate).toHaveBeenCalledWith("/")
  })

  it("treats a legacy row with no kind as direct", async () => {
    mockListScopedSessions.mockResolvedValue([
      { id: "legacy", characterId: "char-1" },
    ] as ChatSession[])

    await openCharacterChat(character, { newChatTitle: "Chat" })

    expect(mockSetActiveSession).toHaveBeenCalledWith("legacy")
    expect(mockStartNewSession).not.toHaveBeenCalled()
  })

  it("skips embedded sessions — a sidechat is not a conversation you can navigate to", async () => {
    mockListScopedSessions.mockResolvedValue([
      { id: "aside", kind: "direct", characterId: "char-1", visibility: "embedded" },
    ] as ChatSession[])

    await openCharacterChat(character, { newChatTitle: "Chat with Research Analyst" })

    expect(mockSetActiveSession).not.toHaveBeenCalled()
    expect(mockStartNewSession).toHaveBeenCalledWith({
      title: "Chat with Research Analyst",
      kind: "direct",
      characterId: "char-1",
    })
  })

  it("creates one with the caller's localized title when the character has no chat yet", async () => {
    const navigate = jest.fn()

    await expect(
      openCharacterChat(character, {
        newChatTitle: "与 Research Analyst 的对话",
        navigate,
        pathname: "/",
      })
    ).resolves.toMatchObject({ id: "created-1" })

    expect(mockStartNewSession).toHaveBeenCalledWith({
      title: "与 Research Analyst 的对话",
      kind: "direct",
      characterId: "char-1",
    })
    // `startNewSession` activates and announces what it creates; doing it a
    // second time here would double-fire the bus event.
    expect(mockSetActiveSession).not.toHaveBeenCalled()
    expect(mockEmitSystemBusEvent).not.toHaveBeenCalled()
    expect(navigate).not.toHaveBeenCalled()
  })
})
