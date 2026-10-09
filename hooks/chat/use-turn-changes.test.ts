/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"
import { renderHook, waitFor } from "@testing-library/react"

import { persistCodeAdoptionTurn } from "@/lib/code-adoption/persist"
import type { CodeAdoptionTurnRow } from "@/lib/code-adoption/types"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"

import { useTurnChanges } from "./use-turn-changes"

const SETTLE = { timeout: 5000 }

function row(over: Partial<CodeAdoptionTurnRow> = {}): CodeAdoptionTurnRow {
  return {
    id: "s1:1:e",
    runId: 1,
    sessionId: "s1",
    workspaceRoot: "/repo",
    agentKind: "in-app",
    model: null,
    ts: 1,
    totalFiles: 1,
    totalAdded: 2,
    totalRemoved: 0,
    files: [{ path: "a.ts", added: 2, removed: 0, isNew: false, hunks: [] }],
    truncated: false,
    assistantMessageId: "m1",
    ...over,
  }
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
})

describe("useTurnChanges", () => {
  it("returns the record stamped with the message and follows later writes", async () => {
    await persistCodeAdoptionTurn(row())
    const { result } = renderHook(() => useTurnChanges("s1", "m1", true))
    await waitFor(() => expect(result.current?.id).toBe("s1:1:e"), SETTLE)

    await persistCodeAdoptionTurn(row({ adoptionState: "reverted" }))
    await waitFor(() => expect(result.current?.adoptionState).toBe("reverted"), SETTLE)
  })

  it("reads nothing while disabled or without a session", async () => {
    await persistCodeAdoptionTurn(row())
    const disabled = renderHook(() => useTurnChanges("s1", "m1", false))
    const sessionless = renderHook(() => useTurnChanges(null, "m1", true))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(disabled.result.current).toBeNull()
    expect(sessionless.result.current).toBeNull()
  })

  it("returns null for a message no turn record names", async () => {
    await persistCodeAdoptionTurn(row())
    const { result } = renderHook(() => useTurnChanges("s1", "other", true))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(result.current).toBeNull()
  })
})
