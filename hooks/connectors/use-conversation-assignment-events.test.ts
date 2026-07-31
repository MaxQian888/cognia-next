/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"
import { renderHook, waitFor } from "@testing-library/react"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { appendAssignmentEvent } from "@/lib/db/conversation-assignment-events"
import { useConversationAssignmentEvents } from "./use-conversation-assignment-events"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
})

const SETTLE = { timeout: 5000 }

describe("useConversationAssignmentEvents", () => {
  it("returns an empty array for a conversation with no trail", async () => {
    const { result } = renderHook(() => useConversationAssignmentEvents("k:none"))
    await waitFor(() => expect(Array.isArray(result.current)).toBe(true), SETTLE)
    expect(result.current).toHaveLength(0)
  })

  it("reactively reflects appended assignment events", async () => {
    const { result } = renderHook(() => useConversationAssignmentEvents("k1"))
    await appendAssignmentEvent({ conversationKey: "k1", kind: "assigned" })
    await waitFor(
      () => expect(result.current.some((e) => e.kind === "assigned")).toBe(true),
      SETTLE
    )
  })

  it("scopes to the requested conversation only", async () => {
    await appendAssignmentEvent({ conversationKey: "other", kind: "status.resolved" })
    const { result } = renderHook(() => useConversationAssignmentEvents("k2"))
    await appendAssignmentEvent({ conversationKey: "k2", kind: "label.added" })
    await waitFor(() => expect(result.current.length).toBe(1), SETTLE)
    expect(result.current[0].kind).toBe("label.added")
  })
})
