/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"
import { renderHook, waitFor } from "@testing-library/react"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import type { OutboundJobRow } from "@/lib/db/connector-types"
import { useLatestOutboundJob } from "./use-latest-outbound-job"

const NOW = 1_750_000_000_000

function job(overrides: Partial<OutboundJobRow> & { id: string }): OutboundJobRow {
  return {
    adapterId: "a1",
    conversationKey: "telegram:a1:123",
    request: {
      conversationRef: { platform: "telegram", adapterId: "a1", chatId: 123 },
      segments: [{ type: "text", text: "hi" }],
      metadata: { idempotencyKey: overrides.id },
    },
    status: "sent",
    attempts: 1,
    createdAt: NOW,
    nextAttemptAt: NOW,
    idempotencyKey: overrides.id,
    source: "ai-run",
    ...overrides,
  }
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
})

describe("useLatestOutboundJob", () => {
  it("returns null when the conversation has no outbound job", async () => {
    const { result } = renderHook(() => useLatestOutboundJob("telegram:a1:nonexistent"))
    await waitFor(() => {
      expect(result.current).toBeNull()
    })
  })

  it("returns the newest job by createdAt for the matching conversationKey", async () => {
    await getDb().outboundQueue.bulkPut([
      job({ id: "old", createdAt: NOW - 60_000, status: "sent" }),
      job({ id: "new", createdAt: NOW - 5_000, status: "failed", lastError: "boom" }),
      job({ id: "mid", createdAt: NOW - 30_000, status: "sent" }),
    ])
    const { result } = renderHook(() => useLatestOutboundJob("telegram:a1:123"))
    await waitFor(() => {
      expect(result.current?.id).toBe("new")
    })
    expect(result.current).toMatchObject({ status: "failed", lastError: "boom" })
  })

  it("ignores other conversations", async () => {
    await getDb().outboundQueue.put(
      job({ id: "other", conversationKey: "telegram:a1:other", createdAt: NOW })
    )
    const { result } = renderHook(() => useLatestOutboundJob("telegram:a1:target"))
    await waitFor(() => {
      expect(result.current).toBeNull()
    })
  })

  it("re-runs reactively when the runner mutates the newest row", async () => {
    await getDb().outboundQueue.put(job({ id: "j1", createdAt: NOW, status: "pending" }))
    const { result } = renderHook(() => useLatestOutboundJob("telegram:a1:123"))
    await waitFor(() => {
      expect(result.current?.status).toBe("pending")
    })
    await getDb().outboundQueue.update("j1", { status: "sent", platformMessageId: "p1" })
    await waitFor(() => {
      expect(result.current?.status).toBe("sent")
    })
    await getDb().outboundQueue.put(job({ id: "j2", createdAt: NOW + 1, status: "deadlettered" }))
    await waitFor(() => {
      expect(result.current?.id).toBe("j2")
    })
  })

  it("returns null for an empty / undefined conversationKey", async () => {
    await getDb().outboundQueue.put(job({ id: "j1" }))
    const empty = renderHook(() => useLatestOutboundJob(""))
    const undef = renderHook(() => useLatestOutboundJob(undefined))
    await waitFor(() => {
      expect(empty.result.current).toBeNull()
      expect(undef.result.current).toBeNull()
    })
  })
})
