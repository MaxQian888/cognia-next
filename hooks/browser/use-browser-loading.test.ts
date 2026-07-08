import { act, renderHook, waitFor } from "@testing-library/react"

import { BROWSER_EVENTS } from "@/lib/browser/protocol"

// `mock`-prefixed names are the only out-of-scope refs jest.mock factories allow.
const mockListeners: Record<string, (p: unknown) => void> = {}
const mockUnlisten = jest.fn()

jest.mock("@/lib/tauri", () => ({ isTauri: () => true }))
jest.mock("@/lib/tauri/events", () => ({
  onTauriEvent: jest.fn(async (event: string, handler: (p: unknown) => void) => {
    mockListeners[event] = handler
    return mockUnlisten
  }),
}))
jest.mock("@/lib/tauri/safe-unlisten", () => ({ safeUnlisten: (fn: () => void) => fn?.() }))

import { useBrowserLoading } from "./use-browser-loading"

const emitLoaded = () =>
  act(() => mockListeners[BROWSER_EVENTS.loaded]?.({ paneId: "browser-embed", url: "http://x/" }))

beforeEach(() => {
  for (const k of Object.keys(mockListeners)) delete mockListeners[k]
  mockUnlisten.mockReset()
})

it("is idle with no committed url", () => {
  const { result } = renderHook(() => useBrowserLoading({ url: null }))
  expect(result.current.phase).toBe("idle")
  expect(result.current.hasPainted).toBe(false)
})

it("enters loading when a url is committed and readies on the loaded event", async () => {
  const { result, rerender } = renderHook(
    (props: { url: string | null }) => useBrowserLoading(props),
    {
      initialProps: { url: null as string | null },
    }
  )
  rerender({ url: "http://localhost:3000/" })
  expect(result.current.phase).toBe("loading")
  expect(result.current.hasPainted).toBe(false)

  await waitFor(() => expect(mockListeners[BROWSER_EVENTS.loaded]).toBeDefined())
  emitLoaded()

  expect(result.current.phase).toBe("ready")
  expect(result.current.hasPainted).toBe(true)
})

it("re-enters loading on begin() but stays painted", async () => {
  const { result, rerender } = renderHook(
    (props: { url: string | null }) => useBrowserLoading(props),
    {
      initialProps: { url: "http://a/" as string | null },
    }
  )
  await waitFor(() => expect(mockListeners[BROWSER_EVENTS.loaded]).toBeDefined())
  emitLoaded()
  expect(result.current.hasPainted).toBe(true)

  // A same-url reload: url doesn't change, so the pane calls begin().
  act(() => result.current.begin())
  expect(result.current.phase).toBe("loading")
  expect(result.current.hasPainted).toBe(true) // subsequent loads never blank the page

  emitLoaded()
  expect(result.current.phase).toBe("ready")

  // A brand-new committed url also re-loads.
  rerender({ url: "http://b/" })
  expect(result.current.phase).toBe("loading")
})

it("force-settles when no loaded signal arrives before the timeout", () => {
  jest.useFakeTimers()
  try {
    const { result } = renderHook(() =>
      useBrowserLoading({ url: "http://a/", settleTimeoutMs: 5000 })
    )
    expect(result.current.phase).toBe("loading")
    act(() => {
      jest.advanceTimersByTime(5000)
    })
    expect(result.current.phase).toBe("ready")
    expect(result.current.hasPainted).toBe(true)
  } finally {
    jest.useRealTimers()
  }
})

it("returns to idle and forgets painting when the url clears", async () => {
  const { result, rerender } = renderHook(
    (props: { url: string | null }) => useBrowserLoading(props),
    {
      initialProps: { url: "http://a/" as string | null },
    }
  )
  await waitFor(() => expect(mockListeners[BROWSER_EVENTS.loaded]).toBeDefined())
  emitLoaded()
  expect(result.current.hasPainted).toBe(true)

  rerender({ url: null })
  expect(result.current.phase).toBe("idle")
  expect(result.current.hasPainted).toBe(false)
})

it("unsubscribes from the loaded event on unmount", async () => {
  const { unmount } = renderHook(() => useBrowserLoading({ url: "http://a/" }))
  await waitFor(() => expect(mockListeners[BROWSER_EVENTS.loaded]).toBeDefined())
  unmount()
  expect(mockUnlisten).toHaveBeenCalled()
})
