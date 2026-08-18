/**
 * @jest-environment jsdom
 */

import { act, renderHook } from "@testing-library/react"

type Observer = { next: (count: number) => void; error: (err: unknown) => void }
let observer: Observer | null = null
const unsubscribe = jest.fn()
const liveQuery = jest.fn((querier: () => unknown) => ({
  subscribe: (o: Observer) => {
    observer = o
    // Run the querier once so the Dexie read itself is covered.
    void querier()
    return { unsubscribe }
  },
}))
jest.mock("dexie", () => ({ liveQuery: (q: () => unknown) => liveQuery(q) }))

const count = jest.fn(async () => 0)
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({ adapterInstances: { count: () => count() } }),
}))

import {
  __resetImConfiguredForTesting,
  getImConfiguredSnapshot,
  subscribeImConfigured,
  useImConfigured,
} from "./use-im-configured"

beforeEach(() => {
  __resetImConfiguredForTesting()
  observer = null
  unsubscribe.mockClear()
  liveQuery.mockClear()
  count.mockClear()
})

describe("useImConfigured", () => {
  it("is false until the shared observer reports a connector, then true", () => {
    const { result } = renderHook(() => useImConfigured())
    expect(result.current).toBe(false)
    expect(liveQuery).toHaveBeenCalledTimes(1)
    expect(count).toHaveBeenCalled()
    act(() => observer!.next(2))
    expect(result.current).toBe(true)
    act(() => observer!.next(0))
    expect(result.current).toBe(false)
  })

  it("shares one Dexie observer across subscribers and stops with the last one", () => {
    const a = renderHook(() => useImConfigured())
    const b = renderHook(() => useImConfigured())
    expect(liveQuery).toHaveBeenCalledTimes(1)
    act(() => observer!.next(1))
    expect(a.result.current).toBe(true)
    expect(b.result.current).toBe(true)
    a.unmount()
    expect(unsubscribe).not.toHaveBeenCalled()
    b.unmount()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    // A later subscriber starts a fresh observer.
    renderHook(() => useImConfigured())
    expect(liveQuery).toHaveBeenCalledTimes(2)
  })

  it("treats a failed read as no connectors and keeps notifying", () => {
    const listener = jest.fn()
    const off = subscribeImConfigured(listener)
    act(() => observer!.next(3))
    expect(getImConfiguredSnapshot()).toBe(true)
    act(() => observer!.error(new Error("boom")))
    expect(getImConfiguredSnapshot()).toBe(false)
    expect(listener).toHaveBeenCalledTimes(2)
    off()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
})
