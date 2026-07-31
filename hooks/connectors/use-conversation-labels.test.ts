/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"
import { renderHook, waitFor } from "@testing-library/react"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { createLabel } from "@/lib/db/conversation-labels"
import { useConversationLabels, useConversationLabelMap } from "./use-conversation-labels"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
})

// Dexie seed + useLiveQuery settle async; allow generous time so the live
// subscription resolves even when many suites run in parallel (CPU contention
// blows past waitFor's 1000ms default and made this flaky in full runs).
const SETTLE = { timeout: 5000 }

describe("useConversationLabels", () => {
  it("seeds built-in labels and returns them sorted by sortOrder", async () => {
    const { result } = renderHook(() => useConversationLabels())
    await waitFor(() => expect(result.current.length).toBeGreaterThan(0), SETTLE)
    expect(result.current.every((l) => l.builtin)).toBe(true)
    const orders = result.current.map((l) => l.sortOrder)
    expect([...orders].sort((a, b) => a - b)).toEqual(orders)
  })

  it("reactively reflects a newly created label", async () => {
    const { result } = renderHook(() => useConversationLabels())
    await waitFor(() => expect(result.current.length).toBeGreaterThan(0), SETTLE)
    await createLabel({ name: "Zeta", sortOrder: 999 })
    await waitFor(() => expect(result.current.some((l) => l.name === "Zeta")).toBe(true), SETTLE)
  })
})

describe("useConversationLabelMap", () => {
  it("returns an id → label lookup", async () => {
    const { result } = renderHook(() => useConversationLabelMap())
    await waitFor(() => expect(result.current.size).toBeGreaterThan(0), SETTLE)
    const first = [...result.current.values()][0]
    expect(result.current.get(first.id)).toEqual(first)
  })
})
