import {
  createOpenNativeSessionInChatDeps,
  NativeSessionBindError,
  openNativeSessionInChat,
  type OpenNativeSessionInChatDeps,
} from "./open-native-session-in-chat"

const mockLiveSessions = jest.fn()
const mockGetSession = jest.fn()
const mockBind = jest.fn()
jest.mock("@/lib/ai/agent/external/manager", () => ({
  getExternalAgentManager: () => ({
    liveSessions: (...args: unknown[]) => mockLiveSessions(...args),
    getSession: (...args: unknown[]) => mockGetSession(...args),
    bindSessionToConversation: (...args: unknown[]) => mockBind(...args),
  }),
}))

const mockStartNewSession = jest.fn()
jest.mock("@/lib/chat/start-session", () => ({
  startNewSession: (...args: unknown[]) => mockStartNewSession(...args),
}))

const mockDbGetSession = jest.fn()
jest.mock("@/lib/db/sessions", () => ({
  getSession: (...args: unknown[]) => mockDbGetSession(...args),
}))

const mockRuntimeState = {
  sessionExternalLinks: {} as Record<
    string,
    { agentId: string; sessionId: string; host?: unknown }
  >,
  setSessionRuntimeRef: jest.fn(),
  setSessionExternalLink: jest.fn(),
}
jest.mock("@/stores/agent/agent-runtime-store", () => ({
  useAgentRuntimeStore: { getState: () => mockRuntimeState },
}))

function fakeDeps(overrides: Partial<OpenNativeSessionInChatDeps> = {}) {
  const calls: string[] = []
  const deps: OpenNativeSessionInChatDeps = {
    isLive: jest.fn(() => false),
    resume: jest.fn(async (id: string) => {
      calls.push(`resume:${id}`)
      return { id }
    }),
    findChat: jest.fn(async () => null),
    startChat: jest.fn(async () => {
      calls.push("startChat")
      return { id: "chat-new" }
    }),
    setRuntime: jest.fn(() => calls.push("setRuntime")),
    setLink: jest.fn(() => calls.push("setLink")),
    bind: jest.fn(() => {
      calls.push("bind")
      return true
    }),
    ...overrides,
  }
  return { deps, calls }
}

describe("openNativeSessionInChat", () => {
  it("resumes, creates a conversation, then binds lane → marker → link in that order", async () => {
    const { deps, calls } = fakeDeps()
    const result = await openNativeSessionInChat(
      "agent-1",
      {
        sessionId: "native-1",
        title: "  Fix login  ",
        cwd: "/repo",
        additionalDirectories: ["/lib"],
      },
      deps
    )
    expect(result).toEqual({
      chatSessionId: "chat-new",
      nativeSessionId: "native-1",
      reused: false,
    })
    expect(deps.resume).toHaveBeenCalledWith("native-1", {
      cwd: "/repo",
      additionalDirectories: ["/lib"],
    })
    expect(deps.startChat).toHaveBeenCalledWith({ title: "Fix login", workingDir: "/repo" })
    // A link written before the lane is refused by the store, so order matters.
    expect(calls).toEqual(["resume:native-1", "startChat", "setRuntime", "bind", "setLink"])
    expect(deps.setRuntime).toHaveBeenCalledWith("chat-new", "agent-1")
    expect(deps.bind).toHaveBeenCalledWith("agent-1", "native-1", "chat-new")
    expect(deps.setLink).toHaveBeenCalledWith("chat-new", {
      agentId: "agent-1",
      sessionId: "native-1",
    })
  })

  it("does not resume a session the agent already holds open", async () => {
    const { deps } = fakeDeps({ isLive: jest.fn(() => true) })
    await openNativeSessionInChat("agent-1", { sessionId: "native-1" }, deps)
    expect(deps.resume).not.toHaveBeenCalled()
    // No title or directory: the seed stays empty rather than blank strings.
    expect(deps.startChat).toHaveBeenCalledWith({})
  })

  it("focuses the conversation that already continues the session", async () => {
    const { deps } = fakeDeps({ findChat: jest.fn(async () => "chat-old") })
    const result = await openNativeSessionInChat("agent-1", { sessionId: "native-1" }, deps)
    expect(result).toEqual({ chatSessionId: "chat-old", nativeSessionId: "native-1", reused: true })
    expect(deps.startChat).not.toHaveBeenCalled()
    expect(deps.bind).toHaveBeenCalledWith("agent-1", "native-1", "chat-old")
  })

  it("binds the id a resume answered with, and looks up both ids", async () => {
    const findChat = jest.fn(async (_agent: string, id: string) =>
      id === "native-1" ? "chat-old" : null
    )
    const { deps } = fakeDeps({ resume: jest.fn(async () => ({ id: "native-2" })), findChat })
    const result = await openNativeSessionInChat("agent-1", { sessionId: "native-1" }, deps)
    expect(findChat.mock.calls.map((call) => call[1])).toEqual(["native-2", "native-1"])
    expect(result).toEqual({ chatSessionId: "chat-old", nativeSessionId: "native-2", reused: true })
    expect(deps.setLink).toHaveBeenCalledWith("chat-old", {
      agentId: "agent-1",
      sessionId: "native-2",
    })
  })

  it("creates no conversation when the agent refuses the resume", async () => {
    const { deps } = fakeDeps({
      resume: jest.fn(async () => {
        throw new Error("resume refused")
      }),
    })
    await expect(
      openNativeSessionInChat("agent-1", { sessionId: "native-1" }, deps)
    ).rejects.toThrow("resume refused")
    expect(deps.startChat).not.toHaveBeenCalled()
    expect(deps.setRuntime).not.toHaveBeenCalled()
  })

  it("fails loudly instead of leaving an unbound conversation pointing nowhere", async () => {
    const { deps } = fakeDeps({ bind: jest.fn(() => false) })
    await expect(
      openNativeSessionInChat("agent-1", { sessionId: "native-1" }, deps)
    ).rejects.toBeInstanceOf(NativeSessionBindError)
    expect(deps.setLink).not.toHaveBeenCalled()
  })
})

describe("createOpenNativeSessionInChatDeps", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockRuntimeState.sessionExternalLinks = {}
  })

  it("reads liveness from the manager and pins the external lane", async () => {
    mockLiveSessions.mockReturnValue([{ id: "native-1" }])
    const resume = jest.fn()
    const deps = await createOpenNativeSessionInChatDeps(resume)
    expect(deps.isLive("agent-1", "native-1")).toBe(true)
    expect(deps.isLive("agent-1", "native-2")).toBe(false)
    expect(deps.resume).toBe(resume)

    deps.setRuntime("chat-1", "agent-1")
    expect(mockRuntimeState.setSessionRuntimeRef).toHaveBeenCalledWith("chat-1", {
      kind: "external",
      agentId: "agent-1",
    })
    deps.setLink("chat-1", { agentId: "agent-1", sessionId: "native-1" })
    expect(mockRuntimeState.setSessionExternalLink).toHaveBeenCalledWith("chat-1", {
      agentId: "agent-1",
      sessionId: "native-1",
    })
    mockBind.mockReturnValue(true)
    expect(deps.bind("agent-1", "native-1", "chat-1")).toBe(true)
    expect(mockBind).toHaveBeenCalledWith("agent-1", "native-1", "chat-1")

    mockStartNewSession.mockResolvedValue({ id: "chat-2" })
    await expect(deps.startChat({ title: "t" })).resolves.toEqual({ id: "chat-2" })
    expect(mockStartNewSession).toHaveBeenCalledWith({ title: "t" })
  })

  it("finds a conversation by the manager marker or a live local link, skipping deleted ones", async () => {
    mockGetSession.mockReturnValue({ metadata: { cogniaSessionId: "chat-deleted" } })
    mockRuntimeState.sessionExternalLinks = {
      "chat-host": { agentId: "agent-1", sessionId: "native-1", host: { configId: "x" } },
      "chat-other": { agentId: "agent-1", sessionId: "native-9" },
      "chat-linked": { agentId: "agent-1", sessionId: "native-1" },
    }
    mockDbGetSession.mockImplementation(async (id: string) =>
      id === "chat-linked" ? { id } : undefined
    )
    const deps = await createOpenNativeSessionInChatDeps(jest.fn())
    await expect(deps.findChat("agent-1", "native-1")).resolves.toBe("chat-linked")
    // A Host-owned link is another lane; it is never a candidate.
    expect(mockDbGetSession.mock.calls.map((call) => call[0])).toEqual([
      "chat-deleted",
      "chat-linked",
    ])

    mockGetSession.mockReturnValue(undefined)
    mockRuntimeState.sessionExternalLinks = {}
    await expect(deps.findChat("agent-1", "native-1")).resolves.toBeNull()
  })
})
