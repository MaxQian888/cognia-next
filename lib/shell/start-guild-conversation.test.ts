import type { ChatSession } from "@cognia/agent-config-types"

const mockStartNewSession = jest.fn()
const mockSetActiveSession = jest.fn()
const mockSetSelectedGuild = jest.fn()
const mockEmitSystemBusEvent = jest.fn()

jest.mock("@/lib/chat/start-session", () => ({
  startNewSession: (...args: unknown[]) => mockStartNewSession(...args),
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

import { startGuildConversation } from "./start-guild-conversation"

describe("startGuildConversation", () => {
  const session = { id: "session-1" } as ChatSession

  beforeEach(() => {
    mockStartNewSession.mockReset().mockResolvedValue(session)
    mockSetActiveSession.mockReset()
    mockSetSelectedGuild.mockReset()
    mockEmitSystemBusEvent.mockReset()
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
