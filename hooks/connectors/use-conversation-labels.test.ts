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

describe("useConversationLabels", () => {
  it("seeds built-in labels and returns them sorted by sortOrder", async () => {
    const { result } = renderHook(() => useConversationLabels())
    await waitFor(() => expect(result.current.length).toBeGreaterThan(0))
    expect(result.current.every((l) => l.builtin)).toBe(true)
    const orders = result.current.map((l) => l.sortOrder)
    expect([...orders].sort((a, b) => a - b)).toEqual(orders)
  })

  it("reactively reflects a newly created label", async () => {
    const { result } = renderHook(() => useConversationLabels())
    await waitFor(() => expect(result.current.length).toBeGreaterThan(0))
    await createLabel({ name: "Zeta", sortOrder: 999 })
    await waitFor(() => expect(result.current.some((l) => l.name === "Zeta")).toBe(true))
  })
})

describe("useConversationLabelMap", () => {
  it("returns an id → label lookup", async () => {
    const { result } = renderHook(() => useConversationLabelMap())
    await waitFor(() => expect(result.current.size).toBeGreaterThan(0))
    const first = [...result.current.values()][0]
    expect(result.current.get(first.id)).toEqual(first)
  })
})
