/** @jest-environment jsdom */
/**
 * The contract is the ordering: the seed message must be persisted against the
 * session the host actually created, and an empty/absent seed must not write a
 * blank message into a fresh transcript.
 */

const startNewSession = jest.fn(async () => ({ id: "sess-1" }))
const persistMessages = jest.fn(async () => undefined)
const makeUserMessage = jest.fn((text: string) => ({ id: "m1", role: "user", text }))

jest.mock("@/lib/chat/start-session", () => ({
  startNewSession: (...a: unknown[]) => startNewSession(...(a as [])),
}))
jest.mock("@/lib/db/messages", () => ({
  persistMessages: (...a: unknown[]) => persistMessages(...(a as [])),
}))
jest.mock("@/lib/claude/adapter", () => ({
  makeUserMessage: (t: string) => makeUserMessage(t),
}))

import { startSeededSession } from "./session-seed"

beforeEach(() => {
  jest.clearAllMocks()
  startNewSession.mockResolvedValue({ id: "sess-1" })
})

describe("startSeededSession", () => {
  it("goes through the host's own entry point, not straight to Dexie", async () => {
    await startSeededSession({ title: "T", characterId: "char-1", projectId: "proj-1" })
    expect(startNewSession).toHaveBeenCalledWith({
      title: "T",
      characterId: "char-1",
      projectId: "proj-1",
    })
  })

  it("persists the seed against the session the host created", async () => {
    startNewSession.mockResolvedValue({ id: "sess-created" })
    const result = await startSeededSession({ seedUserMessage: "write this" })
    expect(makeUserMessage).toHaveBeenCalledWith("write this")
    expect(persistMessages).toHaveBeenCalledWith("sess-created", [
      { id: "m1", role: "user", text: "write this" },
    ])
    expect(result).toEqual({ sessionId: "sess-created" })
  })

  it("does not write a blank first message when there is no seed", async () => {
    await startSeededSession({ characterId: "char-1" })
    expect(persistMessages).not.toHaveBeenCalled()
  })

  it("treats a whitespace-only seed as no seed", async () => {
    await startSeededSession({ seedUserMessage: "   " })
    expect(persistMessages).not.toHaveBeenCalled()
  })

  it("does not pass the seed text through as a session field", async () => {
    await startSeededSession({ seedUserMessage: "hi", title: "T" })
    expect(startNewSession).toHaveBeenCalledWith({ title: "T" })
  })
})
