/**
 * @jest-environment jsdom
 */

import { act, renderHook, waitFor } from "@testing-library/react"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { useInboxAdapters } from "./use-inbox-adapters"

const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
beforeEach(fixture.restore)
afterAll(fixture.dispose)

function adapter(id: string, enabled: boolean) {
  return {
    id,
    type: "telegram",
    displayName: id,
    enabled,
    transportMode: "stub",
    settings: {},
    credentialsRef: { keyringService: "k", accounts: [] },
    trigger: { rules: [], blockers: [] },
    defaultMode: "auto",
    createdAt: 1,
    updatedAt: 1,
  }
}

describe("useInboxAdapters", () => {
  it("is undefined while loading, then lists only enabled adapters", async () => {
    await getDb().adapterInstances.bulkPut([adapter("on", true), adapter("off", false)] as never)
    const { result } = renderHook(() => useInboxAdapters())
    expect(result.current.adapters).toBeUndefined()
    await waitFor(() => expect(result.current.adapters).toBeDefined())
    expect(result.current.adapters!.map((row) => row.id)).toEqual(["on"])
    expect(result.current.error).toBeNull()
  })

  it("captures a failed read and recovers on retry", async () => {
    const table = getDb().adapterInstances
    const spy = jest.spyOn(table, "filter").mockImplementationOnce(() => {
      throw new Error("db closed")
    })
    const { result } = renderHook(() => useInboxAdapters())
    await waitFor(() => expect(result.current.error?.message).toBe("db closed"))
    act(() => result.current.retry())
    await waitFor(() => expect(result.current.adapters).toEqual([]))
    expect(result.current.error).toBeNull()
    spy.mockRestore()
  })
})
