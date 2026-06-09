import { createPluginAgentSession, resumePluginAgentSession } from "./session"
import { executeAgent } from "@/lib/ai/agent/agent-executor"
import { listMessages, persistMessages } from "@/lib/db/messages"
import { createSession, getSession, deleteSession } from "@/lib/db/sessions"

jest.mock("@/lib/ai/agent/agent-executor", () => ({
  __esModule: true,
  executeAgent: jest.fn(),
}))
jest.mock("@/lib/db/messages", () => ({
  __esModule: true,
  listMessages: jest.fn(),
  persistMessages: jest.fn(),
}))
jest.mock("@/lib/db/sessions", () => ({
  __esModule: true,
  createSession: jest.fn(),
  getSession: jest.fn(),
  deleteSession: jest.fn(),
}))

const mockExecute = executeAgent as jest.MockedFunction<typeof executeAgent>
const mockList = listMessages as jest.MockedFunction<typeof listMessages>
const mockPersist = persistMessages as jest.MockedFunction<typeof persistMessages>
const mockCreate = createSession as jest.MockedFunction<typeof createSession>
const mockGet = getSession as jest.MockedFunction<typeof getSession>
const mockDelete = deleteSession as jest.MockedFunction<typeof deleteSession>

beforeEach(() => {
  jest.clearAllMocks()
  mockCreate.mockResolvedValue({ id: "s1", characterId: "c1" } as never)
  mockGet.mockResolvedValue({ id: "s1", characterId: "c1" } as never)
  mockList.mockResolvedValue([])
  mockPersist.mockResolvedValue(undefined)
  mockDelete.mockResolvedValue(undefined)
  mockExecute.mockResolvedValue({
    text: "reply",
    channel: "sidecar",
    toolsAvailable: true,
  } as never)
})

describe("createPluginAgentSession", () => {
  it("creates a durable session and exposes its id", async () => {
    const session = await createPluginAgentSession({ title: "T", characterId: "c1" })
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ title: "T", characterId: "c1" })
    )
    expect(session.id).toBe("s1")
  })

  it("send runs executeAgent in persistent-session mode and persists the turn", async () => {
    const session = await createPluginAgentSession({ characterId: "c1" })
    const res = await session.send("hello", { toolsEnabled: true })
    expect(mockExecute).toHaveBeenCalledWith(
      "hello",
      expect.objectContaining({ sessionId: "s1", toolsEnabled: true, characterId: "c1" })
    )
    // user + assistant turn persisted.
    const persisted = mockPersist.mock.calls[0][1]
    expect(persisted).toHaveLength(2)
    expect(persisted[0].role).toBe("user")
    expect(persisted[1].role).toBe("assistant")
    expect(res).toMatchObject({ text: "reply", channel: "sidecar", toolsAvailable: true })
  })

  it("replays prior turns as priorMessages for the text-channel fallback", async () => {
    mockList.mockResolvedValue([
      { id: "m1", role: "user", parts: [{ type: "text", text: "earlier q" }] },
      { id: "m2", role: "assistant", parts: [{ type: "text", text: "earlier a" }] },
    ] as never)
    const session = await createPluginAgentSession({})
    await session.send("follow-up")
    expect(mockExecute.mock.calls[0][1]).toMatchObject({
      priorMessages: [
        { role: "user", content: "earlier q" },
        { role: "assistant", content: "earlier a" },
      ],
    })
  })

  it("send rejects an empty prompt", async () => {
    const session = await createPluginAgentSession({})
    await expect(session.send("")).rejects.toThrow(/non-empty prompt/)
  })

  it("history maps persisted messages to {role, content}", async () => {
    mockList.mockResolvedValue([
      { id: "m1", role: "user", parts: [{ type: "text", text: "q" }] },
      { id: "m2", role: "assistant", parts: [{ type: "text", text: "a" }] },
    ] as never)
    const session = await createPluginAgentSession({})
    expect(await session.history()).toEqual([
      { role: "user", content: "q" },
      { role: "assistant", content: "a" },
    ])
  })

  it("end deletes the session", async () => {
    const session = await createPluginAgentSession({})
    await session.end()
    expect(mockDelete).toHaveBeenCalledWith("s1")
  })

  it("enforces a cumulative token budget across sends (Package F)", async () => {
    mockExecute.mockResolvedValue({
      text: "r",
      channel: "text",
      toolsAvailable: false,
      usage: { inputTokens: 60, outputTokens: 60, totalTokens: 120 },
    } as never)
    const session = await createPluginAgentSession({ maxTokens: 100 })
    // First send is within budget; records 120 tokens → exhausts the cap.
    await session.send("first")
    await expect(session.send("second")).rejects.toMatchObject({
      name: "PluginBudgetExceededError",
    })
    expect(mockExecute).toHaveBeenCalledTimes(1)
  })

  it("surfaces usage on the send result", async () => {
    mockExecute.mockResolvedValue({
      text: "r",
      channel: "text",
      toolsAvailable: false,
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    } as never)
    const session = await createPluginAgentSession({})
    const res = await session.send("hi")
    expect(res.usage).toEqual({ inputTokens: 1, outputTokens: 2, totalTokens: 3 })
  })
})

describe("resumePluginAgentSession", () => {
  it("returns a handle for an existing session", async () => {
    const session = await resumePluginAgentSession("s1")
    expect(session.id).toBe("s1")
  })

  it("throws when the session does not exist", async () => {
    mockGet.mockResolvedValue(undefined as never)
    await expect(resumePluginAgentSession("missing")).rejects.toThrow(/not found/)
  })
})
