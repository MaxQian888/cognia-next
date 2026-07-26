/** @jest-environment jsdom */

import { consumePendingChatPrompt, queuePendingChatPrompt } from "./pending-prompt"

describe("pending chat prompt", () => {
  beforeEach(() => {
    sessionStorage.clear()
  })

  it("is scoped to one session and consumed exactly once", () => {
    queuePendingChatPrompt("session-1", "Configure my WebDAV backup", { now: 1_000 })

    expect(consumePendingChatPrompt("session-2", { now: 1_001 })).toBeNull()
    expect(consumePendingChatPrompt("session-1", { now: 1_001 })).toBe("Configure my WebDAV backup")
    expect(consumePendingChatPrompt("session-1", { now: 1_002 })).toBeNull()
  })

  it("rejects empty and expired prompts", () => {
    expect(() => queuePendingChatPrompt("session-1", "   ")).toThrow("cannot be empty")

    queuePendingChatPrompt("session-1", "old", { now: 1_000, ttlMs: 100 })
    expect(consumePendingChatPrompt("session-1", { now: 1_101 })).toBeNull()
  })

  it("fails closed when session storage is corrupted", () => {
    sessionStorage.setItem("cognia:pending-chat-prompt", "{not-json")
    expect(consumePendingChatPrompt("session-1")).toBeNull()
    expect(sessionStorage.getItem("cognia:pending-chat-prompt")).toBeNull()
  })
})
