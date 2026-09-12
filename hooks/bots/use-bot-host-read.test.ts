/** @jest-environment jsdom */
import { act, renderHook, waitFor } from "@testing-library/react"
import { createElement } from "react"
import { renderToString } from "react-dom/server"
import { useBotHostRead } from "./use-bot-host-read"
let mockPairing = 0
jest.mock("@/lib/tauri/transport-companion", () => ({
  getCompanionConfigGeneration: () => mockPairing,
}))
let mockProfile = "desktop"
let mockTarget: { call: jest.Mock } | null = null
const mockCall = jest.fn()
jest.mock("@/hooks/use-host-profile", () => ({ useHostProfile: () => mockProfile }))
jest.mock("@/lib/tauri", () => ({ transport: { call: (...args: unknown[]) => mockCall(...args) } }))
jest.mock("@/lib/tauri/transport-routing", () => ({
  getActiveRemoteTransport: () => mockTarget,
  subscribeActiveRemoteTransport: () => () => {},
}))
beforeEach(() => {
  mockPairing = 0
  mockProfile = "desktop"
  mockTarget = null
  mockCall.mockReset()
})
it("does not read remotely on a local host", () => {
  const { result } = renderHook(() => useBotHostRead("catalog"))
  expect(result.current.remote).toBe(false)
  expect(mockCall).not.toHaveBeenCalled()
})
it("reads authoritative form rows and clears them on host switch or disconnection", async () => {
  mockProfile = "cloud-companion"
  mockCall.mockResolvedValue({ rows: [{ id: "host-a", config: { repository: "owner/repo" } }] })
  const { result, rerender } = renderHook(() => useBotHostRead("installations"))
  await waitFor(() => expect(result.current.data).toMatchObject({ rows: [{ id: "host-a" }] }))
  mockTarget = { call: jest.fn().mockRejectedValue(new Error("offline")) }
  rerender()
  expect(result.current.data).toBeUndefined()
  await waitFor(() => expect(result.current.failed).toBe(true))
})
it("ignores a response from a previously selected host", async () => {
  mockProfile = "cloud-companion"
  let finish!: (value: unknown) => void
  mockCall.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const { result, rerender } = renderHook(() => useBotHostRead("catalog"))
  mockTarget = { call: jest.fn().mockResolvedValue({ entries: [{ definitionId: "new-host" }] }) }
  rerender()
  await waitFor(() =>
    expect(result.current.data).toEqual({ entries: [{ definitionId: "new-host" }] })
  )
  await act(async () => finish({ entries: [{ definitionId: "old-host" }] }))
  expect(result.current.data).toEqual({ entries: [{ definitionId: "new-host" }] })
})

it("reports malformed host data as a sync failure", async () => {
  mockProfile = "cloud-companion"
  mockCall.mockResolvedValue({ unexpected: true })
  const { result } = renderHook(() => useBotHostRead("catalog"))
  await waitFor(() => expect(result.current.failed).toBe(true))
  expect(result.current.data).toBeUndefined()
})

it("drops old pairing responses even when the transport object and host profile are unchanged", async () => {
  mockProfile = "cloud-companion"
  let finish!: (value: unknown) => void
  mockCall
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    .mockResolvedValue({ entries: [{ definitionId: "new-pairing" }] })
  const { result } = renderHook(() => useBotHostRead("catalog"))
  act(() => {
    mockPairing += 1
    window.dispatchEvent(new Event("cognia:companion-config-changed"))
  })
  await waitFor(() =>
    expect(result.current.data).toEqual({ entries: [{ definitionId: "new-pairing" }] })
  )
  await act(async () => finish({ entries: [{ definitionId: "old-pairing" }] }))
  expect(result.current.data).toEqual({ entries: [{ definitionId: "new-pairing" }] })
})

it("renders an unpaired server snapshot without starting a host request", () => {
  function ServerRead() {
    const read = useBotHostRead("catalog")
    return createElement("span", null, String(read.remote))
  }
  expect(renderToString(createElement(ServerRead))).toContain("false")
  expect(mockCall).not.toHaveBeenCalled()
})

it.each([
  ["catalog", null],
  ["catalog", { entries: {} }],
  ["installations", { rows: "invalid" }],
  ["credentials", {}],
  ["credentials", { groups: "invalid" }],
] as const)("refuses malformed %s responses before exposing form data", async (view, data) => {
  mockProfile = "mobile-companion"
  mockCall.mockResolvedValue(data)
  const { result } = renderHook(() => useBotHostRead(view))
  await waitFor(() => expect(result.current.failed).toBe(true))
  expect(result.current.loading).toBe(false)
  expect(result.current.data).toBeUndefined()
})

it("reads credential candidates for a mobile companion and resets data when the view changes", async () => {
  mockProfile = "mobile-companion"
  const groups = { github: [{ value: "host-account", kind: "integration-account" }] }
  let finish!: (value: unknown) => void
  mockCall.mockResolvedValueOnce({ groups }).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const { result, rerender } = renderHook(
    ({ view }: { view: "credentials" | "catalog" }) => useBotHostRead(view),
    { initialProps: { view: "credentials" } }
  )
  await waitFor(() => expect(result.current.data).toEqual({ groups }))
  expect(mockCall).toHaveBeenLastCalledWith("bot_console_read", { view: "credentials" })
  rerender({ view: "catalog" })
  expect(result.current.data).toBeUndefined()
  expect(result.current.loading).toBe(true)
  await act(async () => finish({ entries: [] }))
  expect(result.current.data).toEqual({ entries: [] })
})

it("ignores a rejected request after its host has been replaced", async () => {
  let reject!: (reason: unknown) => void
  mockTarget = {
    call: jest.fn(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail
        })
    ),
  }
  const { result, rerender } = renderHook(() => useBotHostRead("catalog"))
  mockTarget = { call: jest.fn().mockResolvedValue({ entries: [] }) }
  rerender()
  await waitFor(() => expect(result.current.data).toEqual({ entries: [] }))
  await act(async () => reject(new Error("old host disconnected")))
  expect(result.current.failed).toBe(false)
  expect(result.current.data).toEqual({ entries: [] })
})

it.each([false, true])(
  "ignores a %s failed stale-pairing response before the change event arrives",
  async (failed) => {
    mockProfile = "cloud-companion"
    let finish!: (value: unknown) => void
    let reject!: (reason: unknown) => void
    mockCall.mockImplementation(
      () =>
        new Promise((resolve, fail) => {
          finish = resolve
          reject = fail
        })
    )
    const { result, unmount } = renderHook(() => useBotHostRead("catalog"))
    mockPairing += 1
    await act(async () => {
      if (failed) reject(new Error("previous pairing"))
      else finish({ entries: [{ definitionId: "previous-pairing" }] })
    })
    expect(result.current.data).toBeUndefined()
    expect(result.current.failed).toBe(false)
    unmount()
  }
)

it("polls every three seconds, clears a failed read on recovery, and stops on unmount", async () => {
  jest.useFakeTimers()
  try {
    mockProfile = "cloud-companion"
    mockCall
      .mockResolvedValueOnce({ rows: [{ id: "first" }] })
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({ rows: [{ id: "recovered" }] })
    const { result, unmount } = renderHook(() => useBotHostRead("installations"))
    await act(async () => {})
    expect(result.current.data).toEqual({ rows: [{ id: "first" }] })
    await act(async () => {
      jest.advanceTimersByTime(2999)
    })
    expect(mockCall).toHaveBeenCalledTimes(1)
    await act(async () => {
      jest.advanceTimersByTime(1)
    })
    expect(result.current.failed).toBe(true)
    expect(result.current.data).toBeUndefined()
    await act(async () => {
      jest.advanceTimersByTime(3000)
    })
    expect(result.current.failed).toBe(false)
    expect(result.current.data).toEqual({ rows: [{ id: "recovered" }] })
    unmount()
    await act(async () => {
      jest.advanceTimersByTime(9000)
    })
    expect(mockCall).toHaveBeenCalledTimes(3)
  } finally {
    jest.useRealTimers()
  }
})

it("clears remote data and stops polling when a desktop returns to its local host", async () => {
  mockTarget = { call: jest.fn().mockResolvedValue({ entries: [] }) }
  const remoteCall = mockTarget.call
  const { result, rerender } = renderHook(() => useBotHostRead("catalog"))
  await waitFor(() => expect(result.current.data).toEqual({ entries: [] }))
  mockTarget = null
  rerender()
  expect(result.current).toEqual({ remote: false, data: undefined, loading: false, failed: false })
  expect(remoteCall).toHaveBeenCalledTimes(1)
  expect(mockCall).not.toHaveBeenCalled()
})
