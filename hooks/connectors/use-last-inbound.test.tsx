/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"
import { renderHook, waitFor } from "@testing-library/react"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { useLastInboundForConversation } from "./use-last-inbound"

const NOW = 1_750_000_000_000

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
})

describe("useLastInboundForConversation", () => {
  it("returns null when no audit rows match", async () => {
    const { result } = renderHook(() =>
      useLastInboundForConversation("telegram:a1:nonexistent", { now: () => NOW })
    )
    await waitFor(() => {
      expect(result.current).toBeNull()
    })
  })

  it("returns the newest inbound.received timestamp for the matching conversationKey", async () => {
    await getDb().connectorAudit.bulkPut([
      {
        id: "old",
        adapterId: "a1",
        kind: "inbound.received",
        at: NOW - 60_000,
        conversationKey: "telegram:a1:123",
      },
      {
        id: "new",
        adapterId: "a1",
        kind: "inbound.received",
        at: NOW - 5_000,
        conversationKey: "telegram:a1:123",
      },
    ])
    const { result } = renderHook(() =>
      useLastInboundForConversation("telegram:a1:123", { now: () => NOW })
    )
    await waitFor(() => {
      expect(result.current).toBe(NOW - 5_000)
    })
  })

  it("ignores other conversationKeys", async () => {
    await getDb().connectorAudit.bulkPut([
      {
        id: "other",
        adapterId: "a1",
        kind: "inbound.received",
        at: NOW - 1_000,
        conversationKey: "telegram:a1:other",
      },
    ])
    const { result } = renderHook(() =>
      useLastInboundForConversation("telegram:a1:target", { now: () => NOW })
    )
    await waitFor(() => {
      expect(result.current).toBeNull()
    })
  })

  it("ignores non-inbound audit kinds", async () => {
    await getDb().connectorAudit.put({
      id: "send",
      adapterId: "a1",
      kind: "delivery.success",
      at: NOW - 1_000,
      conversationKey: "telegram:a1:123",
    })
    const { result } = renderHook(() =>
      useLastInboundForConversation("telegram:a1:123", { now: () => NOW })
    )
    await waitFor(() => {
      expect(result.current).toBeNull()
    })
  })

  it("ignores rows older than the window", async () => {
    await getDb().connectorAudit.put({
      id: "ancient",
      adapterId: "a1",
      kind: "inbound.received",
      at: NOW - 8 * 24 * 60 * 60 * 1000, // 8 days
      conversationKey: "telegram:a1:123",
    })
    const { result } = renderHook(() =>
      useLastInboundForConversation("telegram:a1:123", {
        now: () => NOW,
        windowMs: 7 * 24 * 60 * 60 * 1000,
      })
    )
    await waitFor(() => {
      expect(result.current).toBeNull()
    })
  })

  it("returns null for an empty conversationKey", async () => {
    const { result } = renderHook(() => useLastInboundForConversation("", { now: () => NOW }))
    await waitFor(() => {
      expect(result.current).toBeNull()
    })
  })
})
