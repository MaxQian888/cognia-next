import { act, renderHook, waitFor } from "@testing-library/react"

import { BROWSER_EVENTS, type BrowserSelection } from "@/lib/browser/protocol"

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
jest.mock("@/lib/tauri/safe-unlisten", () => ({ safeUnlisten: (fn: () => void) => fn() }))
jest.mock("@/lib/browser/client", () => ({
  browserClient: {
    embedSetSelectMode: jest.fn().mockResolvedValue(undefined),
    embedDrainSelection: jest.fn(),
  },
}))

import { browserClient } from "@/lib/browser/client"
import { useElementSelection } from "./use-element-selection"

const SELECTION: BrowserSelection = {
  paneId: "browser-pane",
  selector: "#go",
  domPath: "button#go",
  tagName: "button",
  id: "go",
  classes: null,
  rect: { x: 0, y: 0, width: 10, height: 10 },
  outerHTML: '<button id="go"></button>',
  text: "Go",
  pageUrl: "http://localhost:3000/",
  pageTitle: "Home",
}

beforeEach(() => {
  for (const k of Object.keys(mockListeners)) delete mockListeners[k]
  mockUnlisten.mockReset()
  ;(browserClient.embedSetSelectMode as jest.Mock).mockClear().mockResolvedValue(undefined)
  ;(browserClient.embedDrainSelection as jest.Mock).mockReset().mockResolvedValue([SELECTION])
})

it("captures a selection event and disarms select mode", async () => {
  const { result } = renderHook(() => useElementSelection())
  await waitFor(() => expect(mockListeners[BROWSER_EVENTS.elementSelected]).toBeDefined())

  act(() => mockListeners[BROWSER_EVENTS.elementSelected]({ count: 1, generation: 1 }))

  await waitFor(() => expect(result.current.selection?.selector).toBe("#go"))
  expect(result.current.selections).toEqual([SELECTION])
  expect(browserClient.embedDrainSelection).toHaveBeenCalledTimes(1)
  expect(result.current.selectMode).toBe(false)
})

it("retries a failed drain without clearing the prior selection", async () => {
  jest.useFakeTimers()
  ;(browserClient.embedDrainSelection as jest.Mock)
    .mockRejectedValueOnce(new Error("navigation replaced the context"))
    .mockResolvedValueOnce([SELECTION])
  const { result } = renderHook(() => useElementSelection())
  await act(async () => {})

  act(() => mockListeners[BROWSER_EVENTS.elementSelected]({ count: 1, generation: 3 }))
  expect(result.current.selection).toBeNull()
  await act(async () => {
    await jest.advanceTimersByTimeAsync(50)
  })

  expect(result.current.selection).toEqual(SELECTION)
  expect(browserClient.embedDrainSelection).toHaveBeenCalledTimes(2)
  jest.useRealTimers()
})

it("uses signal generation to ignore duplicate drains", async () => {
  const { result } = renderHook(() => useElementSelection())
  await waitFor(() => expect(mockListeners[BROWSER_EVENTS.elementSelected]).toBeDefined())
  act(() => mockListeners[BROWSER_EVENTS.elementSelected]({ count: 1, generation: 4 }))
  await waitFor(() => expect(result.current.selection).toEqual(SELECTION))
  act(() => mockListeners[BROWSER_EVENTS.elementSelected]({ count: 1, generation: 4 }))
  expect(browserClient.embedDrainSelection).toHaveBeenCalledTimes(1)
})

it("records navigation events", async () => {
  const { result } = renderHook(() => useElementSelection())
  await waitFor(() => expect(mockListeners[BROWSER_EVENTS.navigated]).toBeDefined())

  act(() =>
    mockListeners[BROWSER_EVENTS.navigated]({
      paneId: "browser-pane",
      url: "http://localhost:3000/x",
    })
  )
  expect(result.current.navigated?.url).toBe("http://localhost:3000/x")
})

it("setSelectMode drives the overlay and tracks state", async () => {
  const { result } = renderHook(() => useElementSelection())
  await act(async () => {
    await result.current.setSelectMode(true)
  })
  expect(browserClient.embedSetSelectMode).toHaveBeenCalledWith(true)
  expect(result.current.selectMode).toBe(true)
})

it("clearSelection resets the picked element", async () => {
  const { result } = renderHook(() => useElementSelection())
  await waitFor(() => expect(mockListeners[BROWSER_EVENTS.elementSelected]).toBeDefined())
  act(() => mockListeners[BROWSER_EVENTS.elementSelected]({ count: 1, generation: 1 }))
  await waitFor(() => expect(result.current.selection).not.toBeNull())
  act(() => result.current.clearSelection())
  expect(result.current.selection).toBeNull()
  expect(result.current.selections).toEqual([])
})

it("uses a custom select-mode driver when provided", async () => {
  const driver = jest.fn().mockResolvedValue(undefined)
  const { result } = renderHook(() => useElementSelection({ driver }))
  await act(async () => {
    await result.current.setSelectMode(true)
  })
  expect(driver).toHaveBeenCalledWith(true)
  expect(browserClient.embedSetSelectMode).not.toHaveBeenCalled()
  expect(result.current.selectMode).toBe(true)
})

it("unsubscribes on unmount", async () => {
  const { unmount } = renderHook(() => useElementSelection())
  await waitFor(() => expect(mockListeners[BROWSER_EVENTS.elementSelected]).toBeDefined())
  unmount()
  expect(mockUnlisten).toHaveBeenCalled()
})

// `embedDrainSelection` empties a buffer that lives in the page, so it is a
// one-shot read. With two panes mounted both would wake on the same event and
// race; the loser burns five retries and silently drops the pick. Only the
// lease holder subscribes.
it("does not subscribe or drain when this pane does not own the webview", async () => {
  ;(browserClient.embedDrainSelection as jest.Mock).mockResolvedValue([SELECTION])
  const { result, unmount } = renderHook(() => useElementSelection({ enabled: false }))
  await act(async () => {
    await Promise.resolve()
  })
  expect(mockListeners[BROWSER_EVENTS.elementSelected]).toBeUndefined()
  expect(browserClient.embedDrainSelection).not.toHaveBeenCalled()
  expect(result.current.selection).toBeNull()
  unmount()
})
