/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"
import { renderHook, waitFor } from "@testing-library/react"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { createCanned } from "@/lib/db/canned-responses"
import { useCannedResponses } from "./use-canned-responses"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
})

const SETTLE = { timeout: 5000 }

describe("useCannedResponses", () => {
  it("seeds built-in canned responses and returns them", async () => {
    const { result } = renderHook(() => useCannedResponses())
    await waitFor(() => expect(result.current.length).toBeGreaterThan(0), SETTLE)
    expect(result.current.some((c) => c.isBuiltIn)).toBe(true)
  })

  it("reactively reflects a newly created canned response", async () => {
    const { result } = renderHook(() => useCannedResponses())
    await waitFor(() => expect(result.current.length).toBeGreaterThan(0), SETTLE)
    await createCanned({ title: "Zeta", body: "z" })
    await waitFor(() => expect(result.current.some((c) => c.title === "Zeta")).toBe(true), SETTLE)
  })
})
