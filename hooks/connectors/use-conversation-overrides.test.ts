/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"
import { renderHook, waitFor } from "@testing-library/react"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { useConversationOverride, useConversationOverrides } from "./use-conversation-overrides"
import type { ConversationOverrideRow } from "@/lib/db/connector-types"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
})

const NOW = 1_700_000_000_000

function makeRow(partial: Partial<ConversationOverrideRow>): ConversationOverrideRow {
  return {
    id: partial.id ?? "co-1",
    conversationKey: partial.conversationKey ?? "lark:lark-1:oc_x",
    sessionId: partial.sessionId ?? "s1",
    createdAt: NOW,
    updatedAt: NOW,
    ...partial,
  } as ConversationOverrideRow
}

describe("useConversationOverride", () => {
  it("returns the row for the requested conversationKey", async () => {
    await getDb().conversationOverrides.put(
      makeRow({ conversationKey: "lark:lark-1:oc_target", allowComputerUse: true })
    )
    const { result } = renderHook(() => useConversationOverride("lark:lark-1:oc_target"))
    await waitFor(() => {
      expect(result.current?.allowComputerUse).toBe(true)
    })
  })

  it("returns undefined for an unmatched key", async () => {
    const { result } = renderHook(() => useConversationOverride("lark:lark-1:missing"))
    await waitFor(() => {
      expect(result.current).toBeUndefined()
    })
  })

  it("returns undefined when the key is null", async () => {
    const { result } = renderHook(() => useConversationOverride(null))
    await waitFor(() => {
      expect(result.current).toBeUndefined()
    })
  })
})

describe("useConversationOverrides", () => {
  it("returns all rows ordered newest-first when no adapter filter", async () => {
    await getDb().conversationOverrides.bulkPut([
      makeRow({ id: "co-a", conversationKey: "lark:l1:oc_a", updatedAt: NOW - 100 }),
      makeRow({ id: "co-b", conversationKey: "lark:l1:oc_b", updatedAt: NOW - 50 }),
      makeRow({ id: "co-c", conversationKey: "telegram:t1:c", updatedAt: NOW - 10 }),
    ])
    const { result } = renderHook(() => useConversationOverrides())
    await waitFor(() => {
      expect(result.current).toHaveLength(3)
      expect(result.current.map((r) => r.id)).toEqual(["co-c", "co-b", "co-a"])
    })
  })

  it("filters by adapterId via the conversationKey middle segment", async () => {
    await getDb().conversationOverrides.bulkPut([
      makeRow({ id: "co-lark1", conversationKey: "lark:lark-A:oc_1" }),
      makeRow({ id: "co-lark2", conversationKey: "lark:lark-A:oc_2" }),
      makeRow({ id: "co-other", conversationKey: "lark:lark-B:oc_3" }),
      makeRow({ id: "co-tg", conversationKey: "telegram:lark-A:tg_4" }),
    ])
    const { result } = renderHook(() => useConversationOverrides("lark-A"))
    await waitFor(() => {
      const ids = result.current.map((r) => r.id)
      expect(ids).toContain("co-lark1")
      expect(ids).toContain("co-lark2")
      expect(ids).toContain("co-tg") // telegram:lark-A:... also matches the middle segment
      expect(ids).not.toContain("co-other")
    })
  })

  it("returns [] when no rows exist", async () => {
    const { result } = renderHook(() => useConversationOverrides())
    await waitFor(() => {
      expect(result.current).toEqual([])
    })
  })
})
