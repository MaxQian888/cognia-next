/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"
import { renderHook, waitFor } from "@testing-library/react"
import type { UIMessage } from "ai"

import { persistCodeAdoptionTurn } from "@/lib/code-adoption/persist"
import type { CodeAdoptionTurnRow } from "@/lib/code-adoption/types"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { useChatStore } from "@/stores/chat/chat-store"

import {
  promptBeforeMessage,
  turnReviewOptions,
  useSessionTurnReviews,
} from "./use-session-turn-reviews"

const SETTLE = { timeout: 5000 }

function row(runId: number, over: Partial<CodeAdoptionTurnRow> = {}): CodeAdoptionTurnRow {
  return {
    id: `s1:${runId}:e`,
    runId,
    sessionId: "s1",
    taskWorkspaceRunId: `run:s1:${runId}`,
    workspaceRoot: "/repo",
    agentKind: "in-app",
    model: null,
    ts: runId * 100,
    totalFiles: 2,
    totalAdded: 5,
    totalRemoved: 1,
    files: [],
    truncated: false,
    measurement: "taskWorkspace",
    assistantMessageId: `a${runId}`,
    ...over,
  }
}

const user = (id: string, text: string): UIMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text }],
})
const assistant = (id: string): UIMessage => ({ id, role: "assistant", parts: [] })

describe("promptBeforeMessage", () => {
  const messages = [
    user("u1", "Fix the login bug\nwith details"),
    assistant("a1"),
    user("u2", "x".repeat(80)),
    assistant("a2"),
  ]

  it("returns the first line of the opening prompt", () => {
    expect(promptBeforeMessage(messages, "a1")).toBe("Fix the login bug")
  })

  it("truncates a long prompt", () => {
    const prompt = promptBeforeMessage(messages, "a2")!
    expect(prompt).toHaveLength(60)
    expect(prompt.endsWith("…")).toBe(true)
  })

  it("returns null for an unknown message or no message", () => {
    expect(promptBeforeMessage(messages, "missing")).toBeNull()
    expect(promptBeforeMessage(messages, undefined)).toBeNull()
    expect(promptBeforeMessage([assistant("a0")], "a0")).toBeNull()
  })
})

describe("turnReviewOptions", () => {
  it("keeps measured turns with changes, numbered in order, newest first", () => {
    const options = turnReviewOptions(
      [
        row(2),
        row(1),
        row(3, { totalFiles: 0 }),
        row(4, { measurement: "legacyFingerprint" }),
        row(5, { taskWorkspaceRunId: undefined }),
      ],
      [user("u1", "first"), assistant("a1")]
    )
    expect(options.map((option) => [option.ordinal, option.runId, option.prompt])).toEqual([
      [2, "run:s1:2", null],
      [1, "run:s1:1", "first"],
    ])
    expect(options[0]).toMatchObject({ files: 2, added: 5, removed: 1, ts: 200 })
  })
})

describe("useSessionTurnReviews", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    getDb()
    useChatStore.getState().clear()
  })

  it("reads the session's turns live", async () => {
    await persistCodeAdoptionTurn(row(1))
    const { result } = renderHook(() => useSessionTurnReviews("s1"))
    await waitFor(() => expect(result.current).toHaveLength(1), SETTLE)
    await persistCodeAdoptionTurn(row(2))
    await waitFor(() => expect(result.current.map((o) => o.ordinal)).toEqual([2, 1]), SETTLE)
  })

  it("returns nothing without a session", async () => {
    const { result } = renderHook(() => useSessionTurnReviews(null))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(result.current).toEqual([])
  })
})
