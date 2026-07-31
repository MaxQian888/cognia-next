/** @jest-environment jsdom */
const detectState = { tauri: false, capacitor: false }
jest.mock("@/lib/platform/detect", () => ({
  isTauri: () => detectState.tauri,
  isCapacitor: () => detectState.capacitor,
}))
const webCompanionState = { on: false }
jest.mock("@/lib/platform/web-companion", () => ({
  hasWebCompanionTarget: () => webCompanionState.on,
}))
// getSnapshot MUST return a stable reference (uSES contract), so the snapshots
// are factory-closure constants, not fresh objects per call.
jest.mock("@/lib/fleet/fleet-stream-store", () => {
  const empty = { sessions: [], generatedAt: 0 }
  const snap = { sessions: [], generatedAt: 111 }
  return {
    EMPTY_FLEET_SNAPSHOT: empty,
    fleetStreamStore: {
      subscribe: () => () => {},
      getSnapshot: () => snap,
      getServerSnapshot: () => empty,
    },
  }
})
jest.mock("@/lib/fleet/fleet-remote-store", () => {
  const snap = { sessions: [], generatedAt: 222 }
  const empty = { sessions: [], generatedAt: 0 }
  return {
    fleetRemoteStore: {
      subscribe: () => () => {},
      getSnapshot: () => snap,
      getServerSnapshot: () => empty,
    },
  }
})

import { renderHook } from "@testing-library/react"
import { useFleetSnapshot } from "./use-fleet-snapshot"

describe("useFleetSnapshot", () => {
  beforeEach(() => {
    detectState.tauri = false
    detectState.capacitor = false
    webCompanionState.on = false
  })

  it("uses the tauri store on desktop", () => {
    detectState.tauri = true
    const { result } = renderHook(() => useFleetSnapshot())
    expect(result.current.source).toBe("tauri")
    expect(result.current.snapshot.generatedAt).toBe(111)
  })

  it("uses the companion store on capacitor", () => {
    detectState.capacitor = true
    const { result } = renderHook(() => useFleetSnapshot())
    expect(result.current.source).toBe("companion")
    expect(result.current.snapshot.generatedAt).toBe(222)
  })

  it("uses the companion store for a web-companion target", () => {
    webCompanionState.on = true
    const { result } = renderHook(() => useFleetSnapshot())
    expect(result.current.source).toBe("companion")
    expect(result.current.snapshot.generatedAt).toBe(222)
  })

  it("is source=none and empty on an unpaired plain web page", () => {
    const { result } = renderHook(() => useFleetSnapshot())
    expect(result.current.source).toBe("none")
    expect(result.current.snapshot.generatedAt).toBe(0)
  })
})
