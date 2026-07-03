import { act, renderHook } from "@testing-library/react"

import type { ElementRect } from "@/lib/browser/protocol"

let mockOnRect: ((r: ElementRect) => void) | undefined

jest.mock("@/lib/tauri", () => ({ isTauri: () => true }))
jest.mock("@/lib/browser/client", () => ({
  browserClient: {
    embedCreate: jest.fn().mockResolvedValue("browser-embed"),
    embedSetBounds: jest.fn().mockResolvedValue(undefined),
    embedNavigate: jest.fn().mockResolvedValue(undefined),
    embedDestroy: jest.fn().mockResolvedValue(undefined),
    embedSetVisible: jest.fn().mockResolvedValue(undefined),
  },
}))
jest.mock("./use-element-rect", () => ({
  useElementRect: (_ref: unknown, onChange?: (r: ElementRect) => void) => {
    mockOnRect = onChange
    return null
  },
}))

import { browserClient } from "@/lib/browser/client"
import { useBrowserPaneWebview } from "./use-browser-pane-webview"

const ref = { current: null as HTMLElement | null }
const RECT: ElementRect = { x: 0, y: 0, width: 100, height: 100 }

/** Deliver the initial rect the way the real useElementRect does on mount. */
const deliverRect = (rect: ElementRect = RECT) => act(() => mockOnRect?.(rect))

beforeEach(() => {
  mockOnRect = undefined
  ;(browserClient.embedCreate as jest.Mock).mockClear().mockResolvedValue("browser-embed")
  ;(browserClient.embedSetBounds as jest.Mock).mockClear().mockResolvedValue(undefined)
  ;(browserClient.embedNavigate as jest.Mock).mockClear().mockResolvedValue(undefined)
  ;(browserClient.embedDestroy as jest.Mock).mockClear().mockResolvedValue(undefined)
  ;(browserClient.embedSetVisible as jest.Mock).mockClear().mockResolvedValue(undefined)
})

it("creates the embedded webview once url and rect are known", () => {
  renderHook(() => useBrowserPaneWebview(ref, { url: "http://localhost:3000/" }))
  deliverRect()
  expect(browserClient.embedCreate).toHaveBeenCalledWith("http://localhost:3000/", RECT)
})

it("creates when the url arrives after the rect", () => {
  const { rerender } = renderHook(({ url }) => useBrowserPaneWebview(ref, { url }), {
    initialProps: { url: null as string | null },
  })
  deliverRect()
  expect(browserClient.embedCreate).not.toHaveBeenCalled()
  rerender({ url: "http://localhost:3000/" })
  expect(browserClient.embedCreate).toHaveBeenCalledWith("http://localhost:3000/", RECT)
})

it("does not create without a url", () => {
  renderHook(() => useBrowserPaneWebview(ref, { url: null }))
  deliverRect()
  expect(browserClient.embedCreate).not.toHaveBeenCalled()
})

it("syncs bounds when the reserved rect changes after creation", () => {
  renderHook(() => useBrowserPaneWebview(ref, { url: "http://localhost:3000/" }))
  deliverRect()
  act(() => mockOnRect?.({ x: 5, y: 6, width: 200, height: 150 }))
  expect(browserClient.embedSetBounds).toHaveBeenCalledWith({ x: 5, y: 6, width: 200, height: 150 })
})

it("forwards rect changes to onRectChange without re-rendering", () => {
  const onRectChange = jest.fn()
  let renders = 0
  renderHook(() => {
    renders += 1
    return useBrowserPaneWebview(ref, { url: "http://localhost:3000/", onRectChange })
  })
  const rendersAfterMount = renders
  deliverRect()
  act(() => mockOnRect?.({ x: 1, y: 2, width: 30, height: 40 }))
  expect(onRectChange).toHaveBeenCalledWith(RECT)
  expect(onRectChange).toHaveBeenCalledWith({ x: 1, y: 2, width: 30, height: 40 })
  expect(renders).toBe(rendersAfterMount)
})

it("exposes the latest rect via getRect", () => {
  const { result } = renderHook(() => useBrowserPaneWebview(ref, { url: null }))
  expect(result.current.getRect()).toBeNull()
  deliverRect()
  expect(result.current.getRect()).toEqual(RECT)
})

it("navigates (not re-creates) when the url changes", () => {
  const { rerender } = renderHook(({ url }) => useBrowserPaneWebview(ref, { url }), {
    initialProps: { url: "http://localhost:3000/" },
  })
  deliverRect()
  expect(browserClient.embedCreate).toHaveBeenCalledTimes(1)
  rerender({ url: "http://localhost:3000/about" })
  expect(browserClient.embedNavigate).toHaveBeenCalledWith("http://localhost:3000/about")
  expect(browserClient.embedCreate).toHaveBeenCalledTimes(1)
})

it("recovers when embedCreate rejects (allows a later retry)", async () => {
  ;(browserClient.embedCreate as jest.Mock).mockRejectedValueOnce(new Error("boom"))
  renderHook(() => useBrowserPaneWebview(ref, { url: "http://localhost:3000/" }))
  deliverRect()
  // Flush the rejected create; the hook resets its created flag so a later
  // rect change attempts creation again rather than wedging.
  await act(async () => {
    await Promise.resolve()
  })
  act(() => mockOnRect?.({ x: 1, y: 1, width: 10, height: 10 }))
  expect(browserClient.embedCreate).toHaveBeenCalledTimes(2)
  // Bounds sync is skipped while not created.
  expect(browserClient.embedSetBounds).not.toHaveBeenCalled()
})

it("destroys the webview on unmount", () => {
  const { unmount } = renderHook(() =>
    useBrowserPaneWebview(ref, { url: "http://localhost:3000/" })
  )
  deliverRect()
  unmount()
  expect(browserClient.embedDestroy).toHaveBeenCalled()
})

it("setVisible is a no-op before the webview is created", async () => {
  const { result } = renderHook(() => useBrowserPaneWebview(ref, { url: null }))
  await act(async () => {
    await result.current.setVisible(true)
  })
  expect(browserClient.embedSetVisible).not.toHaveBeenCalled()
})

it("setVisible forwards to the client with the current rect", async () => {
  const { result } = renderHook(() => useBrowserPaneWebview(ref, { url: "http://localhost:3000/" }))
  deliverRect()
  await act(async () => {
    await result.current.setVisible(false)
  })
  expect(browserClient.embedSetVisible).toHaveBeenCalledWith(false, RECT)
})
