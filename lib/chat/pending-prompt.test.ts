/** @jest-environment jsdom */

import {
  acknowledgePendingChatPrompt,
  consumePendingChatPrompt,
  peekPendingChatPrompt,
  queuePendingChatPrompt,
} from "./pending-prompt"

describe("pending chat prompt", () => {
  beforeEach(() => {
    sessionStorage.clear()
    localStorage.clear()
  })

  it("is scoped to one session and consumed exactly once", () => {
    queuePendingChatPrompt("session-1", "Configure my WebDAV backup", { now: 1_000 })

    expect(consumePendingChatPrompt("session-2", { now: 1_001 })).toBeNull()
    expect(consumePendingChatPrompt("session-1", { now: 1_001 })).toBe("Configure my WebDAV backup")
    expect(consumePendingChatPrompt("session-1", { now: 1_002 })).toBeNull()
  })

  it("keeps a durable prompt until its exact dispatch is acknowledged", () => {
    const queued = queuePendingChatPrompt("session-1", "Summarize a web page", {
      now: 1_000,
      skillIds: ["skill_builtin_cognia_onboarding"],
      requestId: "onboarding:session-1:summarize-web",
    })

    expect(peekPendingChatPrompt("session-1", { now: 1_001 })).toEqual(
      expect.objectContaining({
        id: queued.id,
        prompt: "Summarize a web page",
        skillIds: ["skill_builtin_cognia_onboarding"],
        requestId: "onboarding:session-1:summarize-web",
      })
    )
    expect(localStorage.getItem("cognia:pending-chat-prompt:v2")).not.toBeNull()

    expect(acknowledgePendingChatPrompt("session-1", "another-dispatch")).toBe(false)
    expect(peekPendingChatPrompt("session-1", { now: 1_002 })?.id).toBe(queued.id)
    expect(acknowledgePendingChatPrompt("session-1", queued.id)).toBe(true)
    expect(peekPendingChatPrompt("session-1", { now: 1_003 })).toBeNull()
  })

  it("migrates the previous session-scoped handoff without losing it", () => {
    sessionStorage.setItem(
      "cognia:pending-chat-prompt",
      JSON.stringify({ sessionId: "session-1", prompt: "legacy", expiresAt: 2_000 })
    )

    expect(peekPendingChatPrompt("session-1", { now: 1_000 })).toEqual(
      expect.objectContaining({ prompt: "legacy", skillIds: [] })
    )
    expect(sessionStorage.getItem("cognia:pending-chat-prompt")).toBeNull()
    expect(localStorage.getItem("cognia:pending-chat-prompt:v2")).not.toBeNull()
  })

  it("rejects empty and expired prompts", () => {
    expect(() => queuePendingChatPrompt("session-1", "   ")).toThrow("cannot be empty")

    queuePendingChatPrompt("session-1", "old", { now: 1_000, ttlMs: 100 })
    expect(consumePendingChatPrompt("session-1", { now: 1_101 })).toBeNull()
  })

  it("fails closed when session storage is corrupted", () => {
    localStorage.setItem("cognia:pending-chat-prompt:v2", "{not-json")
    expect(consumePendingChatPrompt("session-1")).toBeNull()
    expect(localStorage.getItem("cognia:pending-chat-prompt:v2")).toBeNull()
  })
})
