const mockTauriListeners: Record<string, (payload: unknown) => void> = {}
const mockUnlisten = jest.fn()
jest.mock("@/lib/tauri/events", () => ({
  onTauriEvent: jest.fn(async (event: string, handler: (payload: unknown) => void) => {
    mockTauriListeners[event] = handler
    return mockUnlisten
  }),
}))
jest.mock("@/lib/tauri/safe-unlisten", () => ({ safeUnlisten: (fn: () => void) => fn() }))
jest.mock("@/lib/browser/client", () => ({
  browserClient: {
    embedSetSelectMode: jest.fn().mockResolvedValue(undefined),
    embedDrainSelection: jest.fn().mockResolvedValue([]),
    embedClearSelection: jest.fn().mockResolvedValue(undefined),
  },
}))
let mockLocalListener: ((event: unknown) => void) | null = null
const mockLocalUnlisten = jest.fn()
jest.mock("@/lib/browser/local-client", () => ({
  localBrowser: {
    onEvent: jest.fn(async (listener: (event: unknown) => void) => {
      mockLocalListener = listener
      return mockLocalUnlisten
    }),
  },
}))

import { browserClient } from "@/lib/browser/client"
import { BROWSER_EVENTS } from "@/lib/browser/protocol"
import {
  embeddedSelectionSource,
  localSelectionPaneId,
  localSelectionSource,
} from "./selection-source"

beforeEach(() => {
  jest.clearAllMocks()
  mockLocalListener = null
  for (const key of Object.keys(mockTauriListeners)) delete mockTauriListeners[key]
})

describe("embeddedSelectionSource", () => {
  it("drives the embedded webview's commands", async () => {
    await embeddedSelectionSource.setSelectMode(true)
    await embeddedSelectionSource.drain()
    await embeddedSelectionSource.clear()
    expect(browserClient.embedSetSelectMode).toHaveBeenCalledWith(true)
    expect(browserClient.embedDrainSelection).toHaveBeenCalled()
    expect(browserClient.embedClearSelection).toHaveBeenCalled()
  })

  it("listens for pick signals and navigations, and stops both", async () => {
    const onSignal = jest.fn()
    const onNavigated = jest.fn()
    const stop = await embeddedSelectionSource.subscribe({ onSignal, onNavigated })
    mockTauriListeners[BROWSER_EVENTS.elementSelected]({ paneId: "embed", count: 1, generation: 2 })
    mockTauriListeners[BROWSER_EVENTS.navigated]({ paneId: "embed", url: "http://localhost/" })
    expect(onSignal).toHaveBeenCalledWith({ paneId: "embed", count: 1, generation: 2 })
    expect(onNavigated).toHaveBeenCalledWith({ paneId: "embed", url: "http://localhost/" })
    stop()
    expect(mockUnlisten).toHaveBeenCalledTimes(2)
  })
})

describe("localSelectionSource", () => {
  const engine = () => ({
    sessionId: "shared",
    setSelectMode: jest.fn().mockResolvedValue(undefined),
    drainSelection: jest.fn().mockResolvedValue([]),
    clearSelection: jest.fn().mockResolvedValue(undefined),
  })
  const labels = { details: "Details", collapse: "Hide" }

  it("drives the page through the engine, localizing the panel when arming", async () => {
    const e = engine()
    const source = localSelectionSource(e, "p1", labels)
    await source.setSelectMode(true)
    await source.setSelectMode(false)
    await source.drain()
    await source.clear()
    expect(e.setSelectMode.mock.calls).toEqual([
      [true, labels],
      [false, undefined],
    ])
    expect(e.drainSelection).toHaveBeenCalled()
    expect(e.clearSelection).toHaveBeenCalled()
  })

  it("takes only its own page's signals from the shared session", async () => {
    const onSignal = jest.fn()
    const stop = await localSelectionSource(engine(), "p1").subscribe({
      onSignal,
      onNavigated: jest.fn(),
    })
    const signal = {
      type: "element.selected",
      sessionId: "shared",
      pageId: "p1",
      count: 2,
      generation: 7,
    }
    mockLocalListener?.(signal)
    mockLocalListener?.({ ...signal, pageId: "p2" })
    mockLocalListener?.({ ...signal, sessionId: "other" })
    mockLocalListener?.({ type: "pages.changed", sessionId: "shared", pages: [] })
    expect(onSignal.mock.calls).toEqual([
      [{ paneId: localSelectionPaneId("p1"), count: 2, generation: 7 }],
    ])
    expect(localSelectionPaneId("p1")).toBe("local:p1")
    stop()
    expect(mockLocalUnlisten).toHaveBeenCalled()
  })
})
