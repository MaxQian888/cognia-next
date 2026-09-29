/** @jest-environment jsdom */
const commitMessageDelta = jest.fn(async () => undefined)
jest.mock("@/lib/db/messages", () => ({
  commitMessageDelta: (...args: unknown[]) => commitMessageDelta(...(args as [])),
}))

const appendMessageToSession = jest.fn()
let chatState: { sessions: Record<string, unknown>; activeSessionId: string | null }
jest.mock("@/stores/chat", () => ({
  useChatStore: { getState: () => ({ ...chatState, appendMessageToSession }) },
}))

import { buildVideoJobCardMessage, postVideoJobCard } from "./video-job-card"

beforeEach(() => {
  jest.clearAllMocks()
  chatState = { sessions: {}, activeSessionId: null }
})

describe("video job card message", () => {
  it("is a system message carrying one video-job block", () => {
    const message = buildVideoJobCardMessage("vjob_1", 36)
    expect(message).toMatchObject({
      role: "system",
      parts: [{ type: "data-diagnostics", data: { kind: "video-job", jobId: "vjob_1" } }],
    })
    expect(message.id).toMatch(/^sys-video-10-/)
  })

  it("persists the card and shows it in a loaded conversation", async () => {
    chatState = { sessions: { s1: {} }, activeSessionId: "other" }
    await postVideoJobCard("s1", "vjob_1")
    const [sessionId, message] = appendMessageToSession.mock.calls[0]!
    expect(sessionId).toBe("s1")
    expect(commitMessageDelta).toHaveBeenCalledWith("s1", { upserts: [message] })
  })

  it("only writes to disk for a conversation that is not loaded", async () => {
    await postVideoJobCard("s2", "vjob_1")
    expect(appendMessageToSession).not.toHaveBeenCalled()
    expect(commitMessageDelta).toHaveBeenCalledWith("s2", {
      upserts: [expect.objectContaining({ role: "system" })],
    })
  })
})
