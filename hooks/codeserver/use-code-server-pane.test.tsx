import { act, renderHook } from "@testing-library/react"

import type { ElementRect } from "@/lib/browser/protocol"
import type { CodeServerDownloadProgress } from "@/lib/codeserver/client"

let mockOnRect: ((r: ElementRect) => void) | undefined
let mockVisible = true
interface ExitedPayload {
  root: string
  port: number
}
const listeners = new Map<string, (payload: never) => void>()
const emit = <T,>(event: string, payload: T) =>
  (listeners.get(event) as ((p: T) => void) | undefined)?.(payload)
const progressEvent = (p: CodeServerDownloadProgress) => emit("codeserver://download-progress", p)
const exitedEvent = (p: ExitedPayload) => emit("codeserver://instance-exited", p)
let mockIsTauri = true
/** Mirrors the real manager's ownership bookkeeping for `getCodeServerPaneOwner`. */
let paneOwner: string | null = null

jest.mock("@/lib/tauri", () => ({ isTauri: () => mockIsTauri }))
jest.mock("@/lib/tauri/safe-unlisten", () => ({ safeUnlisten: jest.fn() }))
let mockRemoteHostActive = false
jest.mock("@/lib/tauri/transport-routing", () => ({
  isRemoteHostActive: () => mockRemoteHostActive,
}))
jest.mock("@/lib/tauri/events", () => ({
  onTauriEvent: (name: string, cb: (payload: never) => void) => {
    listeners.set(name, cb)
    return Promise.resolve(() => listeners.delete(name))
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
  CODESERVER_EVENTS: {
    downloadProgress: "codeserver://download-progress",
    instanceExited: "codeserver://instance-exited",
  },
  codeServerClient: { supported: jest.fn(), ensure: jest.fn(), stop: jest.fn() },
}))
jest.mock("@/lib/codeserver/pane-manager", () => ({
  claimCodeServerPane: jest.fn(),
  getCodeServerPaneOwner: () => paneOwner,
  releaseCodeServerPane: jest.fn(),
  setCodeServerPaneVisible: jest.fn(),
  updateCodeServerPaneRect: jest.fn(),
}))

import { codeServerClient } from "@/lib/codeserver/client"
import {
  claimCodeServerPane,
  releaseCodeServerPane,
  setCodeServerPaneVisible,
  updateCodeServerPaneRect,
} from "@/lib/codeserver/pane-manager"
import { useCodeServerPane } from "./use-code-server-pane"

const client = codeServerClient as jest.Mocked<typeof codeServerClient>
const claim = claimCodeServerPane as jest.Mock
const release = releaseCodeServerPane as jest.Mock
const setVisible = setCodeServerPaneVisible as jest.Mock
const updateRect = updateCodeServerPaneRect as jest.Mock

const ref = { current: null as HTMLElement | null }
const RECT: ElementRect = { x: 0, y: 0, width: 100, height: 100 }
const ROOT = "/work/proj"
const OWNER = "team:t1"

const options = (
  overrides: Partial<{
    root: string
    profile: "managed" | "native"
    onRevoked: () => void
  }> = {}
) => ({
  root: overrides.root ?? ROOT,
  ownerId: OWNER,
  ...(overrides.profile ? { profile: overrides.profile } : {}),
  onRevoked: overrides.onRevoked ?? jest.fn(),
})

const deliverRect = (rect: ElementRect = RECT) => act(() => mockOnRect?.(rect))
const flush = () =>
  act(async () => {
    await Promise.resolve()
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
  mockIsTauri = true
  mockRemoteHostActive = false
  listeners.clear()
  paneOwner = null
  client.supported.mockReset().mockResolvedValue(true)
  client.ensure.mockReset().mockResolvedValue({ running: true, port: 43117, version: "4.128.0" })
  client.stop.mockReset().mockResolvedValue(true)
  claim.mockReset().mockImplementation(({ ownerId }: { ownerId: string }) => {
    paneOwner = ownerId
    return Promise.resolve()
  })
  release.mockReset()
  setVisible.mockReset()
  updateRect.mockReset()
})

it("reports unsupported outside Tauri without probing the backend", async () => {
  mockIsTauri = false
  const { result } = renderHook(() => useCodeServerPane(ref, options()))
  await flush()
  expect(result.current.phase).toBe("unsupported")
  expect(client.supported).not.toHaveBeenCalled()
})

it("reports unsupported when the platform has no code-server binary", async () => {
  client.supported.mockResolvedValue(false)
  const { result } = renderHook(() => useCodeServerPane(ref, options()))
  await flush()
  expect(result.current.phase).toBe("unsupported")
  expect(client.ensure).not.toHaveBeenCalled()
})

it("ensures code-server and claims the shared pane at the loopback port", async () => {
  const { result } = renderHook(() => useCodeServerPane(ref, options()))
  await flush()
  deliverRect()
  await flush()

  expect(client.ensure).toHaveBeenCalledWith(ROOT, "managed")
  expect(result.current.phase).toBe("ready")
  expect(claim).toHaveBeenCalledWith({
    ownerId: OWNER,
    root: ROOT,
    url: "http://127.0.0.1:43117/",
    rect: RECT,
    onRevoked: expect.any(Function),
  })
})

it("re-claims with the new url when the selected project root changes", async () => {
  client.ensure
    .mockResolvedValueOnce({ running: true, port: 43117, version: "4.128.0" })
    .mockResolvedValueOnce({ running: true, port: 43118, version: "4.128.0" })
  let root = ROOT
  const { rerender } = renderHook(() => useCodeServerPane(ref, options({ root })))
  await flush()
  deliverRect()
  await flush()

  root = "/work/other"
  rerender()
  await flush()

  expect(client.ensure).toHaveBeenLastCalledWith("/work/other", "managed")
  expect(claim).toHaveBeenLastCalledWith({
    ownerId: OWNER,
    root: "/work/other",
    url: "http://127.0.0.1:43118/",
    rect: RECT,
    onRevoked: expect.any(Function),
  })
})

it("pushes later rects through the manager instead of re-claiming", async () => {
  renderHook(() => useCodeServerPane(ref, options()))
  await flush()
  deliverRect()
  await flush()
  claim.mockClear()

  const next: ElementRect = { x: 5, y: 6, width: 70, height: 80 }
  deliverRect(next)

  expect(updateRect).toHaveBeenCalledWith(OWNER, next)
  expect(claim).not.toHaveBeenCalled()
})

it("forwards revocation from the manager to the host", async () => {
  const onRevoked = jest.fn()
  renderHook(() => useCodeServerPane(ref, options({ onRevoked })))
  await flush()
  deliverRect()
  await flush()

  const revoke = claim.mock.calls[0][0].onRevoked as () => void
  revoke()

  expect(onRevoked).toHaveBeenCalledTimes(1)
})

it("surfaces pane claim failures as retryable errors", async () => {
  claim.mockRejectedValueOnce(new Error("main window not found"))
  const { result } = renderHook(() => useCodeServerPane(ref, options()))
  await flush()
  deliverRect()
  await flush()

  expect(result.current.phase).toBe("error")
  expect(result.current.error).toContain("main window not found")

  act(() => result.current.retry())
  await flush()
  expect(result.current.phase).toBe("ready")
})

it("parks the pane right after claiming when the region is already hidden", async () => {
  mockVisible = false
  renderHook(() => useCodeServerPane(ref, options()))
  await flush()
  deliverRect()
  await flush()

  expect(setVisible).toHaveBeenCalledWith(OWNER, false)
})

it("reflects region visibility changes onto the manager", async () => {
  const { rerender } = renderHook(() => useCodeServerPane(ref, options()))
  await flush()
  deliverRect()
  await flush()
  setVisible.mockClear()

  mockVisible = false
  rerender()

  expect(setVisible).toHaveBeenCalledWith(OWNER, false)
})

it("surfaces download progress before it becomes ready", async () => {
  const pending = deferred<{ running: boolean; port: number; version: string }>()
  client.ensure.mockReturnValue(pending.promise)
  const { result } = renderHook(() => useCodeServerPane(ref, options()))
  await flush() // supported() resolves, progress subscription registers
  act(() => progressEvent({ stage: "downloading", bytesDone: 50, bytesTotal: 100, message: "" }))
  expect(result.current.phase).toBe("downloading")
  expect(result.current.progress).toBeCloseTo(0.5)
  // Let ensure finish so no act warnings leak.
  await act(async () => {
    pending.resolve({ running: true, port: 5, version: "4.128.0" })
    await Promise.resolve()
  })
})

it("ignores non-download progress stages", async () => {
  const pending = deferred<{ running: boolean; port: number; version: string }>()
  client.ensure.mockReturnValue(pending.promise)
  const { result } = renderHook(() => useCodeServerPane(ref, options()))
  await flush()
  act(() => progressEvent({ stage: "verifying", bytesDone: 1, bytesTotal: 1, message: "" }))
  expect(result.current.phase).toBe("starting")
  await act(async () => {
    pending.resolve({ running: true, port: 5, version: "4.128.0" })
    await Promise.resolve()
  })
})

it("enters the error phase and retry re-runs ensure", async () => {
  client.ensure.mockRejectedValueOnce(new Error("spawn failed"))
  const { result } = renderHook(() => useCodeServerPane(ref, options()))
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

it("reports mounted only after the claim resolves", async () => {
  let settle: () => void = () => {}
  claim.mockImplementation(({ ownerId }: { ownerId: string }) => {
    paneOwner = ownerId
    return new Promise<void>((resolve) => {
      settle = resolve
    })
  })
  const { result } = renderHook(() => useCodeServerPane(ref, options()))
  await flush()
  deliverRect()
  await flush()

  // code-server is healthy, but the native webview has not landed yet.
  expect(result.current.phase).toBe("ready")
  expect(result.current.mounted).toBe(false)

  await act(async () => {
    settle()
    await Promise.resolve()
  })
  expect(result.current.mounted).toBe(true)
})

it("parks the webview whenever the pane is not ready", async () => {
  // The webview floats above the DOM, so a dead instance left on screen would
  // hide this pane's own error + retry UI.
  const { result } = renderHook(() => useCodeServerPane(ref, options()))
  await flush()
  deliverRect()
  await flush()
  setVisible.mockClear()

  act(() => exitedEvent({ root: ROOT, port: 43117 }))

  expect(result.current.phase).toBe("error")
  expect(setVisible).toHaveBeenCalledWith(OWNER, false)
})

it("reports an unknown fraction when the download size is not advertised", async () => {
  const pending = deferred<{ running: boolean; port: number; version: string }>()
  client.ensure.mockReturnValue(pending.promise)
  const { result } = renderHook(() => useCodeServerPane(ref, options()))
  await flush()

  act(() => progressEvent({ stage: "downloading", bytesDone: 10, bytesTotal: 0, message: "" }))

  expect(result.current.phase).toBe("downloading")
  expect(result.current.progress).toBeNull()
  await act(async () => {
    pending.resolve({ running: true, port: 5, version: "4.128.0" })
    await Promise.resolve()
  })
})

it("does not claim the pane when ensure returns no port", async () => {
  client.ensure.mockResolvedValue({ running: false, port: null, version: "4.128.0" })
  const { result } = renderHook(() => useCodeServerPane(ref, options()))
  await flush()
  deliverRect()
  await flush()

  expect(result.current.phase).toBe("ready")
  expect(claim).not.toHaveBeenCalled()
})

it("ignores rect updates outside Tauri", async () => {
  mockIsTauri = false
  renderHook(() => useCodeServerPane(ref, options()))
  await flush()

  deliverRect()

  expect(claim).not.toHaveBeenCalled()
  expect(updateRect).not.toHaveBeenCalled()
})

it("drops a late ensure result after unmount", async () => {
  const pending = deferred<{ running: boolean; port: number; version: string }>()
  client.ensure.mockReturnValue(pending.promise)
  const { unmount } = renderHook(() => useCodeServerPane(ref, options()))
  await flush()
  deliverRect()

  unmount()
  await act(async () => {
    pending.resolve({ running: true, port: 43117, version: "4.128.0" })
    await Promise.resolve()
  })

  // The unmounted pane must not grab the shared webview from whoever has it now.
  expect(claim).not.toHaveBeenCalled()
})

it("leaves ready when the watchdog reports this instance died", async () => {
  const { result } = renderHook(() => useCodeServerPane(ref, options()))
  await flush()
  deliverRect()
  await flush()
  expect(result.current.phase).toBe("ready")

  act(() => exitedEvent({ root: ROOT, port: 43117 }))

  expect(result.current.phase).toBe("error")
  expect(result.current.error).toContain(ROOT)
})

it("recovers onto the replacement instance when retried after a watchdog exit", async () => {
  // The backend refuses to re-adopt an instance that failed its health check, so
  // the retry comes back on a fresh port — and the pane re-claims at that port
  // instead of sitting on the dead page.
  const { result } = renderHook(() => useCodeServerPane(ref, options()))
  await flush()
  deliverRect()
  await flush()

  act(() => exitedEvent({ root: ROOT, port: 43117 }))
  expect(result.current.phase).toBe("error")

  claim.mockClear()
  client.ensure.mockResolvedValueOnce({ running: true, port: 43201, version: "4.128.0" })
  await act(async () => {
    result.current.retry()
    await Promise.resolve()
  })
  await flush()

  expect(client.ensure).toHaveBeenCalledTimes(2)
  expect(result.current.phase).toBe("ready")
  expect(claim).toHaveBeenLastCalledWith({
    ownerId: OWNER,
    root: ROOT,
    url: "http://127.0.0.1:43201/",
    rect: RECT,
    onRevoked: expect.any(Function),
  })
})

it("ignores a watchdog exit for a different instance", async () => {
  const { result } = renderHook(() => useCodeServerPane(ref, options()))
  await flush()
  deliverRect()
  await flush()

  act(() => exitedEvent({ root: "/work/other", port: 59999 }))

  expect(result.current.phase).toBe("ready")
})

it("releases — never destroys — the pane on unmount", async () => {
  const { unmount } = renderHook(() => useCodeServerPane(ref, options()))
  await flush()
  deliverRect()
  await flush()

  unmount()

  expect(release).toHaveBeenCalledWith(OWNER)
})

describe("restart", () => {
  it("stops the instance and brings a fresh one up", async () => {
    // `retry` alone re-`ensure`s and would hand back the *same* healthy instance;
    // a locale change is only read at workbench startup, so the process has to go.
    const { result } = renderHook(() => useCodeServerPane(ref, options()))
    await flush()
    deliverRect()
    await flush()
    expect(result.current.phase).toBe("ready")
    client.ensure.mockClear()

    act(() => result.current.restart())
    await flush()

    expect(client.stop).toHaveBeenCalledWith(ROOT)
    expect(client.ensure).toHaveBeenCalledWith(ROOT, "managed")
    expect(result.current.phase).toBe("ready")
  })

  it("covers the pane with the placeholder while the old workbench goes away", async () => {
    const { result } = renderHook(() => useCodeServerPane(ref, options()))
    await flush()
    deliverRect()
    await flush()

    // Never resolves: hold the restart mid-flight and inspect the interim state.
    client.stop.mockReturnValue(new Promise<boolean>(() => {}))
    act(() => result.current.restart())

    expect(result.current.phase).toBe("starting")
    expect(result.current.mounted).toBe(false)
  })

  it("still respawns when the stop itself fails", async () => {
    // Otherwise a failed stop strands the pane in `starting` with no way out; the
    // ensure path prunes an unhealthy instance on its own.
    const { result } = renderHook(() => useCodeServerPane(ref, options()))
    await flush()
    deliverRect()
    await flush()
    client.ensure.mockClear()
    client.stop.mockRejectedValue(new Error("no such instance"))

    act(() => result.current.restart())
    await flush()

    expect(client.ensure).toHaveBeenCalledWith(ROOT, "managed")
    expect(result.current.phase).toBe("ready")
  })
})

describe("trust-domain profile", () => {
  it("serves the root from the requested profile", async () => {
    renderHook(() => useCodeServerPane(ref, options({ profile: "native" })))
    await flush()

    expect(client.ensure).toHaveBeenCalledWith(ROOT, "native")
  })

  it("re-ensures and re-claims when the profile switches", async () => {
    // Managed and native are separate processes on separate ports, so a switch
    // has to replace the workbench — reconfiguring the running one is not an
    // option and would silently leave the user in the old trust domain.
    client.ensure
      .mockResolvedValueOnce({ running: true, port: 43117, version: "4.128.0" })
      .mockResolvedValueOnce({ running: true, port: 43119, version: "4.128.0" })
    let profile: "managed" | "native" = "managed"
    const { rerender } = renderHook(() => useCodeServerPane(ref, options({ profile })))
    await flush()
    deliverRect()
    await flush()

    profile = "native"
    rerender()
    await flush()

    expect(client.ensure).toHaveBeenLastCalledWith(ROOT, "native")
    expect(claim).toHaveBeenLastCalledWith({
      ownerId: OWNER,
      root: ROOT,
      url: "http://127.0.0.1:43119/",
      rect: RECT,
      onRevoked: expect.any(Function),
    })
  })
})

describe("crash watchdog through a remote relay", () => {
  it("matches a remote exit by root, since the ports cannot line up", async () => {
    // The host emits its OWN loopback port; `port` here is the desktop relay's.
    // Matching on port would never fire and the pane would sit on a dead page.
    mockRemoteHostActive = true
    const { result } = renderHook(() => useCodeServerPane(ref, options()))
    await flush()
    deliverRect()
    await flush()
    expect(result.current.phase).toBe("ready")

    act(() => exitedEvent({ root: ROOT, port: 61999 }))
    expect(result.current.phase).toBe("error")
  })

  it("tolerates a trailing-slash difference in the reported root", async () => {
    mockRemoteHostActive = true
    const { result } = renderHook(() => useCodeServerPane(ref, options()))
    await flush()
    deliverRect()
    await flush()

    act(() => exitedEvent({ root: `${ROOT}/`, port: 61999 }))
    expect(result.current.phase).toBe("error")
  })

  it("ignores a remote exit for a different project root", async () => {
    mockRemoteHostActive = true
    const { result } = renderHook(() => useCodeServerPane(ref, options()))
    await flush()
    deliverRect()
    await flush()

    act(() => exitedEvent({ root: "/work/other", port: 43117 }))
    expect(result.current.phase).toBe("ready")
  })

  it("keeps matching on port when no remote host is active", async () => {
    const { result } = renderHook(() => useCodeServerPane(ref, options()))
    await flush()
    deliverRect()
    await flush()

    // Locally `root` is the backend's canonicalized spelling and may differ, so
    // the port stays the sharper key.
    act(() => exitedEvent({ root: "/private/work/proj", port: 43117 }))
    expect(result.current.phase).toBe("error")
  })
})
