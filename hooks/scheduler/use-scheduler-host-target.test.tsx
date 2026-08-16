/** @jest-environment jsdom */
import { act, renderHook, waitFor } from "@testing-library/react"

const state = { target: "local" as "local" | "paired", paired: false }
const listeners = new Set<() => void>()
const setPreferred = jest.fn((next: "local" | "paired") => {
  state.target = next
  listeners.forEach((l) => l())
})
const describeMock = jest.fn(async (target: string) =>
  target === "paired"
    ? { platform: "headless", capabilities: ["shell", "sidecar"] }
    : { platform: "web", capabilities: ["webview"] }
)
jest.mock("@/lib/scheduler/scheduler-host-target", () => ({
  getEffectiveSchedulerHostTarget: () => state.target,
  isPairedSchedulerHostAvailable: () => state.paired,
  setPreferredSchedulerHostTarget: (t: "local" | "paired") => setPreferred(t),
  subscribeSchedulerHostTarget: (l: () => void) => {
    listeners.add(l)
    return () => listeners.delete(l)
  },
  describeSchedulerTargetHost: (t: string) => describeMock(t),
}))
jest.mock("@/lib/tauri/transport-routing", () => ({
  subscribeActiveRemoteTransport: () => () => undefined,
}))

import { useSchedulerHostTarget, useSchedulerTargetHost } from "./use-scheduler-host-target"

beforeEach(() => {
  state.target = "local"
  state.paired = false
  listeners.clear()
  jest.clearAllMocks()
})

describe("useSchedulerHostTarget", () => {
  it("exposes the effective target, availability, and a setter that re-renders", () => {
    state.paired = true
    const { result } = renderHook(() => useSchedulerHostTarget())
    expect(result.current).toMatchObject({ target: "local", pairedAvailable: true })
    act(() => result.current.setTarget("paired"))
    expect(setPreferred).toHaveBeenCalledWith("paired")
    expect(result.current.target).toBe("paired")
  })
})

describe("useSchedulerTargetHost", () => {
  it("resolves the descriptor for the effective target and refreshes when it flips", async () => {
    const { result } = renderHook(() => useSchedulerTargetHost())
    await waitFor(() => expect(result.current.platform).toBe("web"))
    act(() => setPreferred("paired"))
    await waitFor(() => expect(result.current.platform).toBe("headless"))
    expect(describeMock).toHaveBeenLastCalledWith("paired")
  })

  it("honours an explicit target", async () => {
    const { result } = renderHook(() => useSchedulerTargetHost("paired"))
    await waitFor(() => expect(result.current.platform).toBe("headless"))
  })
})
