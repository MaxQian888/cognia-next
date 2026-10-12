/** @jest-environment jsdom */
const commitMessageDelta = jest.fn(async () => undefined)
jest.mock("@/lib/db/messages", () => ({
  commitMessageDelta: (...args: unknown[]) => commitMessageDelta(...(args as [])),
}))

const upsertSessionMessages = jest.fn()
let chatState: { sessions: Record<string, unknown>; activeSessionId: string | null }
jest.mock("@/stores/chat", () => ({
  useChatStore: { getState: () => ({ ...chatState, upsertSessionMessages }) },
}))

import type { UIMessage } from "ai"
import { shellJobTranscript, upsertShellJobMessage } from "./shell-job-transcript"

const message: UIMessage = {
  id: "sys-shell-job-1",
  role: "system",
  parts: [{ type: "text", text: "$ ls (exit 0)" }],
}

beforeEach(() => {
  jest.clearAllMocks()
  chatState = { sessions: {}, activeSessionId: null }
})

describe("shell job transcript", () => {
  it("upserts into a loaded conversation and persists the row", async () => {
    chatState = { sessions: { s1: {} }, activeSessionId: "other" }
    await upsertShellJobMessage("s1", message)
    expect(upsertSessionMessages).toHaveBeenCalledWith("s1", [message])
    expect(commitMessageDelta).toHaveBeenCalledWith("s1", { upserts: [message] })
  })

  it("treats the focused conversation as loaded", async () => {
    chatState = { sessions: {}, activeSessionId: "s1" }
    await upsertShellJobMessage("s1", message)
    expect(upsertSessionMessages).toHaveBeenCalledWith("s1", [message])
  })

  it("only writes to disk for a conversation that is not loaded", async () => {
    await shellJobTranscript.upsert("s2", message)
    expect(upsertSessionMessages).not.toHaveBeenCalled()
    expect(commitMessageDelta).toHaveBeenCalledWith("s2", { upserts: [message] })
  })
})
