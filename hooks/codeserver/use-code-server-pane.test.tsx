import { act, renderHook } from "@testing-library/react"

import type { ElementRect } from "@/lib/browser/protocol"
import type { CodeServerDownloadProgress } from "@/lib/codeserver/client"

let mockOnRect: ((r: ElementRect) => void) | undefined
let mockVisible = true
let progressCb: ((p: CodeServerDownloadProgress) => void) | undefined

jest.mock("@/lib/tauri", () => ({ isTauri: () => true }))
jest.mock("@/lib/tauri/safe-unlisten", () => ({ safeUnlisten: jest.fn() }))
jest.mock("@/lib/tauri/events", () => ({
  onTauriEvent: (_name: string, cb: (p: CodeServerDownloadProgress) => void) => {
    progressCb = cb
    return Promise.resolve(() => {})
  },
}))
jest.mock("@/hooks/browser/use-element-rect", () => ({
  useElementRect: (_ref: unknown, onChange?: (r: ElementRect) => void) => {
    mockOnRect = onChange
    return null
  },
}))
jest.mock("@/hooks/browser/use-region-visibility", () => ({
  useRegionVisibility: () => mockVisible,
}))
jest.mock("@/lib/codeserver/client", () => ({
  CODESERVER_EVENTS: { downloadProgress: "codeserver://download-progress" },
  codeServerClient: {
    supported: jest.fn(),
    ensure: jest.fn(),
    embedCreate: jest.fn(),
    embedSetBounds: jest.fn(),
    embedSetVisible: jest.fn(),
    embedNavigate: jest.fn(),
    embedDestroy: jest.fn(),
  },
}))

import { codeServerClient } from "@/lib/codeserver/client"
import { useCodeServerPane } from "./use-code-server-pane"

const client = codeServerClient as jest.Mocked<typeof codeServerClient>
const ref = { current: null as HTMLElement | null }
const RECT: ElementRect = { x: 0, y: 0, width: 100, height: 100 }
const ROOT = "/work/proj"

const deliverRect = (rect: ElementRect = RECT) => act(() => mockOnRect?.(rect))
const flush = () =>
  act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })

/** A promise plus its resolve/reject, for controlling async ensure timing. */
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  mockOnRect = undefined
  mockVisible = true
  progressCb = undefined
  client.supported.mockReset().mockResolvedValue(true)
  client.ensure.mockReset().mockResolvedValue({ running: true, port: 43117, version: "4.128.0" })
  client.embedCreate.mockReset().mockResolvedValue("codeserver-embed")
  client.embedSetBounds.mockReset().mockResolvedValue(undefined)
  client.embedSetVisible.mockReset().mockResolvedValue(undefined)
  client.embedNavigate.mockReset().mockResolvedValue(undefined)
  client.embedDestroy.mockReset().mockResolvedValue(undefined)
})

it("is idle and does not ensure when inactive", async () => {
  const { result } = renderHook(() => useCodeServerPane(ref, { root: ROOT, active: false }))
  await flush()
  expect(result.current.phase).toBe("idle")
  expect(client.ensure).not.toHaveBeenCalled()
})

it("reports unsupported when the platform has no code-server binary", async () => {
  client.supported.mockResolvedValue(false)
  const { result } = renderHook(() => useCodeServerPane(ref, { root: ROOT, active: true }))
  await flush()
  expect(result.current.phase).toBe("unsupported")
  expect(client.ensure).not.toHaveBeenCalled()
})

it("ensures code-server and mounts the webview at the loopback port", async () => {
  const { result } = renderHook(() => useCodeServerPane(ref, { root: ROOT, active: true }))
  await flush()
  deliverRect()
  await flush()
  expect(client.ensure).toHaveBeenCalledWith(ROOT)
  expect(result.current.phase).toBe("ready")
  expect(client.embedCreate).toHaveBeenCalledWith("http://127.0.0.1:43117/", RECT)
})

it("surfaces download progress before it becomes ready", async () => {
  const pending = deferred<{ running: boolean; port: number; version: string }>()
  client.ensure.mockReturnValue(pending.promise)
  const { result } = renderHook(() => useCodeServerPane(ref, { root: ROOT, active: true }))
  await flush() // supported() resolves, progress subscription registers
  act(() => progressCb?.({ stage: "downloading", bytesDone: 50, bytesTotal: 100, message: "" }))
  expect(result.current.phase).toBe("downloading")
  expect(result.current.progress).toBeCloseTo(0.5)
  // Let ensure finish so no act warnings leak.
  await act(async () => {
    pending.resolve({ running: true, port: 5, version: "4.128.0" })
    await Promise.resolve()
  })
})

it("enters the error phase and retry re-runs ensure", async () => {
  client.ensure.mockRejectedValueOnce(new Error("spawn failed"))
  const { result } = renderHook(() => useCodeServerPane(ref, { root: ROOT, active: true }))
  await flush()
  expect(result.current.phase).toBe("error")
  expect(result.current.error).toContain("spawn failed")

  client.ensure.mockResolvedValueOnce({ running: true, port: 6, version: "4.128.0" })
  await act(async () => {
    result.current.retry()
    await Promise.resolve()
  })
  await flush()
  expect(client.ensure).toHaveBeenCalledTimes(2)
  expect(result.current.phase).toBe("ready")
})

it("parks the webview off-screen when the region becomes invisible", async () => {
  const { rerender } = renderHook(() => useCodeServerPane(ref, { root: ROOT, active: true }))
  await flush()
  deliverRect()
  await flush()
  client.embedSetVisible.mockClear()
  mockVisible = false
  rerender()
  expect(client.embedSetVisible).toHaveBeenCalledWith(false, RECT)
})

it("destroys the webview on unmount", async () => {
  const { unmount } = renderHook(() => useCodeServerPane(ref, { root: ROOT, active: true }))
  await flush()
  deliverRect()
  await flush()
  unmount()
  expect(client.embedDestroy).toHaveBeenCalled()
})
