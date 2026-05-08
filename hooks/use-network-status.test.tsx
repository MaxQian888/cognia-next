/**
 * @jest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react"

import { useNetworkStatus } from "./use-network-status"

const subscribers: Array<(s: { connected: boolean; connectionType: string }) => void> = []
jest.mock("@/lib/capacitor/network", () => ({
  getStatus: jest.fn(async () => ({
    kind: "ok",
    status: { connected: true, connectionType: "wifi" },
  })),
  subscribe: jest.fn(
    async (handler: (s: { connected: boolean; connectionType: string }) => void) => {
      subscribers.push(handler)
      return () => {
        const idx = subscribers.indexOf(handler)
        if (idx >= 0) subscribers.splice(idx, 1)
      }
    }
  ),
}))

beforeEach(() => {
  subscribers.length = 0
})

describe("useNetworkStatus", () => {
  it("loads initial status then resolves loading=false", async () => {
    const { result } = renderHook(() => useNetworkStatus())
    expect(result.current.loading).toBe(true)
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.status).toEqual({ connected: true, connectionType: "wifi" })
  })

  it("updates on subscription events", async () => {
    const { result } = renderHook(() => useNetworkStatus())
    await waitFor(() => expect(result.current.loading).toBe(false))
    act(() => {
      subscribers.forEach((h) => h({ connected: false, connectionType: "none" }))
    })
    await waitFor(() =>
      expect(result.current.status).toEqual({ connected: false, connectionType: "none" })
    )
  })

  it("unsubscribes on unmount", async () => {
    const { unmount } = renderHook(() => useNetworkStatus())
    await waitFor(() => expect(subscribers.length).toBeGreaterThan(0))
    unmount()
    await waitFor(() => expect(subscribers).toHaveLength(0))
  })
})
