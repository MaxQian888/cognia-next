import { act, renderHook } from "@testing-library/react"

import type { ElementRect } from "@/lib/browser/protocol"

let mockOnRect: ((r: ElementRect) => void) | undefined
let mockOnRects: Array<(r: ElementRect) => void> = []
let mockProxyErrorHandler: ((payload: { paneId: string; code: string }) => void) | undefined

jest.mock("@/lib/tauri", () => ({ isTauri: () => true }))
jest.mock("@/lib/tauri/events", () => ({
  onTauriEvent: jest.fn(
    async (_event: string, handler: (payload: { paneId: string; code: string }) => void) => {
      mockProxyErrorHandler = handler
      return jest.fn()
    }
  ),
}))
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

/** Let the create/destroy promise chains settle. */
const settle = () =>
  act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })

/**
 * Mount one pane and keep hold of ITS rect callback. Index-based lookup into
 * `mockOnRects` is not safe: the mocked `useElementRect` re-registers on every
 * render, and ownership changes re-render.
 */
const mountPane = (url: string, ownerId: string) => {
  const slot = mockOnRects.length
  const hook = renderHook(() => useBrowserPaneWebview(ref, { url, ownerId }))
  return { ...hook, deliverRect: () => act(() => mockOnRects[slot]?.(RECT)) }
}

beforeEach(() => {
  mockOnRect = undefined
  mockOnRects = []
  mockProxyErrorHandler = undefined
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
  // The very first rect is what creates the webview and claims the lease, and
  // ownership is observable state — so it legitimately re-renders once. The
  // invariant that matters is every rect after that: a scroll or resize burst
  // must reach `onRectChange` without touching React at all.
  deliverRect()
  const rendersAfterClaim = renders
  act(() => mockOnRect?.({ x: 1, y: 2, width: 30, height: 40 }))
  act(() => mockOnRect?.({ x: 3, y: 4, width: 30, height: 40 }))
  act(() => mockOnRect?.({ x: 5, y: 6, width: 30, height: 40 }))
  expect(onRectChange).toHaveBeenCalledWith(RECT)
  expect(onRectChange).toHaveBeenCalledWith({ x: 1, y: 2, width: 30, height: 40 })
  expect(renders).toBe(rendersAfterClaim)
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

it("reports native creation failures to the owning surface", async () => {
  const error = new Error("PROXY_TRANSPORT_UNSUPPORTED")
  const onError = jest.fn()
  ;(browserClient.embedCreate as jest.Mock).mockRejectedValueOnce(error)
  renderHook(() => useBrowserPaneWebview(ref, { url: "https://example.com/", onError }))

  deliverRect()
  await act(async () => Promise.resolve())

  expect(onError).toHaveBeenCalledWith(error)
})

it("reports native navigation failures to the owning surface", async () => {
  const error = new Error("PROXY_CONNECT_FAILED")
  const onError = jest.fn()
  ;(browserClient.embedNavigate as jest.Mock).mockRejectedValueOnce(error)
  const { rerender } = renderHook(({ url }) => useBrowserPaneWebview(ref, { url, onError }), {
    initialProps: { url: "https://example.com/" },
  })
  deliverRect()

  rerender({ url: "https://example.org/" })
  await act(async () => Promise.resolve())

  expect(onError).toHaveBeenCalledWith(error)
})

it("reports fail-closed in-page proxy routing errors from native events", async () => {
  const onError = jest.fn()
  renderHook(() => useBrowserPaneWebview(ref, { url: "https://example.com/", onError }))
  deliverRect()
  await act(async () => Promise.resolve())

  act(() => {
    mockProxyErrorHandler?.({
      paneId: "browser-embed",
      code: "PROXY_TRANSPORT_UNSUPPORTED",
    })
  })

  expect(onError).toHaveBeenCalledWith(
    expect.objectContaining({
      message: "PROXY_TRANSPORT_UNSUPPORTED",
    })
  )
})

it("re-evaluates the current WebView route after native proxy apply succeeds", () => {
  renderHook(() => useBrowserPaneWebview(ref, { url: "https://example.com/" }))
  deliverRect()
  ;(browserClient.embedNavigate as jest.Mock).mockClear()

  act(() => window.dispatchEvent(new Event("cognia:network-proxy-applied")))

  expect(browserClient.embedNavigate).toHaveBeenCalledWith("https://example.com/")
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
  const first = mountPane("http://localhost:3000/", "browser")
  first.deliverRect()
  const second = mountPane("http://localhost:4173/", "sites")
  second.deliverRect()
  expect(browserClient.embedCreate).toHaveBeenCalledTimes(1)

  first.unmount()
  await settle()
  expect(browserClient.embedDestroy).toHaveBeenCalledTimes(1)
  expect(browserClient.embedCreate).toHaveBeenLastCalledWith("http://localhost:4173/", RECT)
  second.unmount()
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

// There is exactly one native child webview, so at most one mounted pane can
// drive it. Before the lease was observable, the losing pane sat on its loading
// placeholder for the full settle timeout and then showed a blank region, while
// its toolbar kept firing commands the native side rejected.
describe("lease ownership", () => {
  it("reports ownership to the pane that holds the lease", () => {
    const first = mountPane("http://localhost:3000/", "first")
    first.deliverRect()
    const second = mountPane("http://localhost:4173/", "second")
    second.deliverRect()

    expect(first.result.current.owned).toBe(true)
    expect(second.result.current.owned).toBe(false)
    expect(browserClient.embedCreate).toHaveBeenCalledTimes(1)

    first.unmount()
    second.unmount()
  })

  it("hands the lease over on takeLease, tearing the old webview down first", async () => {
    const first = mountPane("http://localhost:3000/", "first")
    first.deliverRect()
    const second = mountPane("http://localhost:4173/", "second")
    second.deliverRect()

    act(() => second.result.current.takeLease())
    await settle()

    expect(browserClient.embedDestroy).toHaveBeenCalledTimes(1)
    expect(browserClient.embedCreate).toHaveBeenLastCalledWith("http://localhost:4173/", RECT)
    expect(second.result.current.owned).toBe(true)
    expect(first.result.current.owned).toBe(false)

    first.unmount()
    second.unmount()
  })

  it("lets the dispossessed pane take the lease back", async () => {
    const first = mountPane("http://localhost:3000/", "first")
    first.deliverRect()
    const second = mountPane("http://localhost:4173/", "second")
    second.deliverRect()

    act(() => second.result.current.takeLease())
    await settle()
    act(() => first.result.current.takeLease())
    await settle()

    expect(first.result.current.owned).toBe(true)
    expect(second.result.current.owned).toBe(false)
    expect(browserClient.embedCreate).toHaveBeenLastCalledWith("http://localhost:3000/", RECT)

    first.unmount()
    second.unmount()
  })

  it("is a no-op for the pane that already holds it", () => {
    const only = mountPane("http://localhost:3000/", "only")
    only.deliverRect()
    expect(only.result.current.owned).toBe(true)
    act(() => only.result.current.takeLease())
    expect(browserClient.embedDestroy).not.toHaveBeenCalled()
    only.unmount()
  })
})

describe("a repeated request for the address the pane already holds", () => {
  // The regression: committed url is A, the page navigates itself to B, then
  // the user asks for A again. The web and remote surfaces consume a request
  // nonce, but the native branch only watched `url` — which never changed — so
  // React bailed out of the identical setState and the webview stayed on B.
  it("navigates again when only the nonce moves", async () => {
    const { rerender } = renderHook(
      ({ nonce }: { nonce: number }) =>
        useBrowserPaneWebview(ref, { url: "http://a.test/", navigateNonce: nonce }),
      { initialProps: { nonce: 1 } }
    )
    deliverRect()
    await settle()
    expect(browserClient.embedCreate).toHaveBeenCalledWith("http://a.test/", RECT)
    // Creating IS the first navigation; it must not also navigate.
    expect(browserClient.embedNavigate).not.toHaveBeenCalled()

    rerender({ nonce: 2 })

    expect(browserClient.embedNavigate).toHaveBeenCalledTimes(1)
    expect(browserClient.embedNavigate).toHaveBeenCalledWith("http://a.test/")
  })

  it("stays put while the nonce does, however often it re-renders", async () => {
    const { rerender } = renderHook(
      ({ nonce }: { nonce: number }) =>
        useBrowserPaneWebview(ref, { url: "http://a.test/", navigateNonce: nonce }),
      { initialProps: { nonce: 1 } }
    )
    deliverRect()
    await settle()

    rerender({ nonce: 1 })
    rerender({ nonce: 1 })

    expect(browserClient.embedNavigate).not.toHaveBeenCalled()
  })

  it("navigates once when a request changes the address as well", async () => {
    const { rerender } = renderHook(
      ({ nonce, url }: { nonce: number; url: string }) =>
        useBrowserPaneWebview(ref, { url, navigateNonce: nonce }),
      { initialProps: { nonce: 1, url: "http://a.test/" } }
    )
    deliverRect()
    await settle()

    rerender({ nonce: 2, url: "http://b.test/" })

    expect(browserClient.embedNavigate).toHaveBeenCalledTimes(1)
    expect(browserClient.embedNavigate).toHaveBeenCalledWith("http://b.test/")
  })

  it("does not navigate before the webview exists", () => {
    const { rerender } = renderHook(
      ({ nonce }: { nonce: number }) =>
        useBrowserPaneWebview(ref, { url: "http://a.test/", navigateNonce: nonce }),
      { initialProps: { nonce: 1 } }
    )
    // No rect yet, so nothing was created and this pane holds no lease.
    rerender({ nonce: 2 })
    expect(browserClient.embedNavigate).not.toHaveBeenCalled()
    expect(browserClient.embedCreate).not.toHaveBeenCalled()
  })
})
