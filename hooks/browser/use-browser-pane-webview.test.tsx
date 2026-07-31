import { act, renderHook } from "@testing-library/react"

import type { ElementRect } from "@/lib/browser/protocol"

let mockOnRect: ((r: ElementRect) => void) | undefined
let mockOnRects: Array<(r: ElementRect) => void> = []

jest.mock("@/lib/tauri", () => ({ isTauri: () => true }))
jest.mock("@/lib/browser/client", () => ({
  browserClient: {
    setEmbedOwnerToken: jest.fn(),
    embedCreate: jest.fn().mockResolvedValue("browser-embed"),
    embedSetBounds: jest.fn().mockResolvedValue(undefined),
    embedNavigate: jest.fn().mockResolvedValue(undefined),
    embedDestroy: jest.fn().mockResolvedValue(undefined),
    embedSetVisible: jest.fn().mockResolvedValue(undefined),
  },
}))
jest.mock("./use-element-rect", () => ({
  ...jest.requireActual("./use-element-rect"),
  useElementRect: (_ref: unknown, onChange?: (r: ElementRect) => void) => {
    mockOnRect = onChange
    if (onChange) mockOnRects.push(onChange)
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
  mockOnRects = []
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

it("reports readiness only after native creation succeeds", async () => {
  let resolveCreate!: (paneId: string) => void
  ;(browserClient.embedCreate as jest.Mock).mockImplementationOnce(
    () =>
      new Promise<string>((resolve) => {
        resolveCreate = resolve
      })
  )
  const onReady = jest.fn()
  renderHook(() => useBrowserPaneWebview(ref, { url: "http://localhost:3000/", onReady }))

  deliverRect()
  expect(onReady).not.toHaveBeenCalled()

  await act(async () => resolveCreate("browser-embed"))
  expect(onReady).toHaveBeenCalledTimes(1)
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

it("re-measures and syncs native bounds after a known React layout change", () => {
  const element = document.createElement("div")
  element.getBoundingClientRect = () =>
    ({
      left: 5.4,
      top: 6.6,
      width: 200,
      height: 150,
    }) as DOMRect
  const elementRef = { current: element }
  const { result } = renderHook(() =>
    useBrowserPaneWebview(elementRef, { url: "http://localhost:3000/" })
  )
  deliverRect()
  ;(browserClient.embedSetBounds as jest.Mock).mockClear()

  act(() => result.current.refreshBounds())

  expect(browserClient.embedSetBounds).toHaveBeenCalledWith({
    x: 5,
    y: 7,
    width: 200,
    height: 150,
  })
})

it("does not refresh bounds before the reserved element mounts", () => {
  const { result } = renderHook(() => useBrowserPaneWebview(ref, { url: null }))

  act(() => result.current.refreshBounds())

  expect(browserClient.embedSetBounds).not.toHaveBeenCalled()
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
  expect(browserClient.embedCreate).toHaveBeenLastCalledWith("http://localhost:3000/", {
    x: 1,
    y: 1,
    width: 10,
    height: 10,
  })
})

it("backs off instead of spinning while another native window owns the lease", async () => {
  jest.useFakeTimers()
  ;(browserClient.embedCreate as jest.Mock)
    .mockRejectedValueOnce(new Error("embedded browser is owned by another Cognia surface"))
    .mockResolvedValueOnce("browser-embed")

  try {
    renderHook(() => useBrowserPaneWebview(ref, { url: "http://localhost:3000/" }))
    deliverRect()
    await act(async () => Promise.resolve())
    expect(browserClient.embedCreate).toHaveBeenCalledTimes(1)

    act(() => jest.advanceTimersByTime(249))
    expect(browserClient.embedCreate).toHaveBeenCalledTimes(1)
    await act(async () => jest.advanceTimersByTime(1))
    expect(browserClient.embedCreate).toHaveBeenCalledTimes(2)
  } finally {
    jest.useRealTimers()
  }
})

it("destroys the webview on unmount", () => {
  const { unmount } = renderHook(() =>
    useBrowserPaneWebview(ref, { url: "http://localhost:3000/" })
  )
  deliverRect()
  unmount()
  expect(browserClient.embedDestroy).toHaveBeenCalled()
})

it("leases the singleton webview and hands it to the next mounted owner", async () => {
  const first = renderHook(() =>
    useBrowserPaneWebview(ref, { url: "http://localhost:3000/", ownerId: "browser" })
  )
  act(() => mockOnRects[0]?.(RECT))
  const second = renderHook(() =>
    useBrowserPaneWebview(ref, { url: "http://localhost:4173/", ownerId: "sites" })
  )
  act(() => mockOnRects[1]?.(RECT))
  expect(browserClient.embedCreate).toHaveBeenCalledTimes(1)

  first.unmount()
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
  expect(browserClient.embedDestroy).toHaveBeenCalledTimes(1)
  expect(browserClient.embedCreate).toHaveBeenLastCalledWith("http://localhost:4173/", RECT)
  second.unmount()
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

it("parks the webview off-screen right after creating it when starting hidden", async () => {
  renderHook(() => useBrowserPaneWebview(ref, { url: "http://localhost:3000/", visible: false }))
  await act(async () => {
    mockOnRect?.(RECT)
    await Promise.resolve()
  })
  expect(browserClient.embedCreate).toHaveBeenCalled()
  expect(browserClient.embedSetVisible).toHaveBeenCalledWith(false, RECT)
})

it("reveals / parks the webview when the visible prop flips", () => {
  const { rerender } = renderHook(
    ({ visible }) => useBrowserPaneWebview(ref, { url: "http://localhost:3000/", visible }),
    {
      initialProps: { visible: true },
    }
  )
  deliverRect()
  ;(browserClient.embedSetVisible as jest.Mock).mockClear()

  rerender({ visible: false })
  expect(browserClient.embedSetVisible).toHaveBeenCalledWith(false, RECT)
  ;(browserClient.embedSetVisible as jest.Mock).mockClear()
  rerender({ visible: true })
  expect(browserClient.embedSetVisible).toHaveBeenCalledWith(true, RECT)
})

it("does not churn bounds while parked, then reveals at the fresh rect", () => {
  const { rerender } = renderHook(
    ({ visible }) => useBrowserPaneWebview(ref, { url: "http://localhost:3000/", visible }),
    {
      initialProps: { visible: true },
    }
  )
  deliverRect()
  rerender({ visible: false })
  ;(browserClient.embedSetBounds as jest.Mock).mockClear()

  // Rect churn while parked must not move the (off-screen) webview.
  const moved = { x: 9, y: 9, width: 300, height: 200 }
  act(() => mockOnRect?.(moved))
  expect(browserClient.embedSetBounds).not.toHaveBeenCalled()

  // Revealing uses the latest rect the observer recorded while hidden.
  ;(browserClient.embedSetVisible as jest.Mock).mockClear()
  rerender({ visible: true })
  expect(browserClient.embedSetVisible).toHaveBeenCalledWith(true, moved)
})
