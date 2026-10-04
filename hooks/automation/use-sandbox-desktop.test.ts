import { act, renderHook } from "@testing-library/react"
import { useSandboxDesktop } from "./use-sandbox-desktop"
import { sandboxClient } from "@/lib/automation/sandbox-client"

jest.mock("@/lib/automation/sandbox-client", () => ({
  sandboxClient: {
    desktopFrame: jest.fn(),
    acquireControl: jest.fn(),
    renewControl: jest.fn(),
    releaseControl: jest.fn(),
    controlInput: jest.fn(),
  },
}))
const client = jest.mocked(sandboxClient)
const frame = { bytes: "aA==", width: 800, height: 600, capturedAt: 42, format: "png" as const }
async function tick(ms = 0) {
  await act(async () => {
    jest.advanceTimersByTime(ms)
  })
}
beforeEach(() => {
  jest.useFakeTimers()
  jest.resetAllMocks()
  client.desktopFrame.mockResolvedValue(frame)
  client.acquireControl.mockImplementation(async () => ({
    token: "lease",
    expiresAt: Date.now() + 15000,
  }))
  client.renewControl.mockImplementation(async () => ({
    token: "lease",
    expiresAt: Date.now() + 15000,
  }))
  client.releaseControl.mockResolvedValue(undefined)
  client.controlInput.mockResolvedValue(undefined)
})
afterEach(() => jest.useRealTimers())

test("starts read-only, polls sequentially, and stops on unmount", async () => {
  const { result, unmount } = renderHook(() => useSandboxDesktop("c1", true))
  await tick()
  expect(result.current.frame).toEqual(frame)
  expect(result.current.controlling).toBe(false)
  expect(await result.current.input({ kind: "click" }, { x: 1, y: 2 }, 42)).toBe(false)
  expect(client.controlInput).not.toHaveBeenCalled()
  await tick(1000)
  expect(client.desktopFrame).toHaveBeenCalledTimes(2)
  unmount()
  await tick(5000)
  expect(client.desktopFrame).toHaveBeenCalledTimes(2)
})

test("renews human control and releases on blur", async () => {
  const { result } = renderHook(() => useSandboxDesktop("c1", true))
  await tick()
  await act(async () => {
    await result.current.acquire()
  })
  expect(result.current.controlling).toBe(true)
  await act(async () => {
    expect(await result.current.input({ kind: "typeText", text: "中文" }, null, 42)).toBe(true)
  })
  await tick(5000)
  expect(client.renewControl).toHaveBeenCalledWith("c1", "lease")
  await act(async () => {
    window.dispatchEvent(new Event("blur"))
  })
  expect(result.current.controlling).toBe(false)
  expect(client.releaseControl).toHaveBeenCalledWith("c1", "lease")
})

test("releases a late lease after unmount instead of retaining invisible control", async () => {
  let resolve!: (lease: { token: string; expiresAt: number }) => void
  client.acquireControl.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r
      })
  )
  const { result, unmount } = renderHook(() => useSandboxDesktop("c1", true))
  await tick()
  act(() => {
    void result.current.acquire()
  })
  unmount()
  await act(async () => {
    resolve({ token: "late", expiresAt: Date.now() + 15000 })
  })
  expect(client.releaseControl).toHaveBeenCalledWith("c1", "late")
})

test("capture failures clear stale pixels, release control, and recover automatically", async () => {
  const { result } = renderHook(() => useSandboxDesktop("c1", true))
  await tick()
  await act(async () => {
    await result.current.acquire()
  })
  client.desktopFrame.mockRejectedValueOnce(new Error("offline"))
  await tick(1000)
  expect(result.current.frame).toBeNull()
  expect(result.current.controlling).toBe(false)
  expect(result.current.error).toBe("capture")
  await tick(1000)
  expect(result.current.frame).toEqual(frame)
  expect(result.current.error).toBeNull()
})

test("no overlapping capture requests or work on disabled connections", async () => {
  client.desktopFrame.mockImplementationOnce(() => new Promise(() => {}))
  const { result, rerender } = renderHook(({ enabled }) => useSandboxDesktop("c1", enabled), {
    initialProps: { enabled: true },
  })
  await tick()
  await tick(5000)
  await act(async () => {
    await result.current.refresh()
  })
  expect(client.desktopFrame).toHaveBeenCalledTimes(1)
  rerender({ enabled: false })
  await tick(5000)
  expect(client.desktopFrame).toHaveBeenCalledTimes(1)
})

test("rejects stale frame inputs and releases control after renewal failure", async () => {
  const { result } = renderHook(() => useSandboxDesktop("c1", true))
  await tick()
  await act(async () => {
    await result.current.acquire()
  })
  expect(await result.current.input({ kind: "click" }, { x: 0, y: 0 }, 41)).toBe(false)
  client.renewControl.mockRejectedValueOnce(new Error("expired"))
  await tick(5000)
  expect(result.current.controlling).toBe(false)
  expect(result.current.error).toBe("control")
  expect(client.controlInput).not.toHaveBeenCalled()
})

test("accepted keyboard input survives a capture refresh while queued", async () => {
  let completeFirst!: () => void
  client.controlInput.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        completeFirst = resolve
      })
  )
  const { result } = renderHook(() => useSandboxDesktop("c1", true))
  await tick()
  await act(async () => {
    await result.current.acquire()
  })
  const first = result.current.input({ kind: "typeText", text: "a" }, null, 42)
  const second = result.current.input({ kind: "typeText", text: "b" }, null, 42)
  client.desktopFrame.mockResolvedValue({ ...frame, capturedAt: 43 })
  await tick(1000)
  expect(result.current.frame?.capturedAt).toBe(43)
  await act(async () => {
    completeFirst()
    expect(await first).toBe(true)
    expect(await second).toBe(true)
  })
  expect(client.controlInput).toHaveBeenNthCalledWith(2, "c1", "lease", null, {
    kind: "typeText",
    text: "b",
  })
})

test("queued pointer input is rejected if a capture changes desktop dimensions", async () => {
  let completeFirst!: () => void
  client.controlInput.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        completeFirst = resolve
      })
  )
  const { result } = renderHook(() => useSandboxDesktop("c1", true))
  await tick()
  await act(async () => {
    await result.current.acquire()
  })
  const first = result.current.input({ kind: "typeText", text: "a" }, null, 42)
  const second = result.current.input({ kind: "click" }, { x: 10, y: 10 }, 42)
  client.desktopFrame.mockResolvedValue({ ...frame, width: 400, capturedAt: 43 })
  await tick(1000)
  await act(async () => {
    completeFirst()
    await first
    expect(await second).toBe(false)
  })
  expect(client.controlInput).toHaveBeenCalledTimes(1)
})

test("client-local capture and control continue without an external network", async () => {
  const online = jest.spyOn(navigator, "onLine", "get").mockReturnValue(false)
  try {
    const { result } = renderHook(() => useSandboxDesktop("c1", true))
    await tick()
    expect(result.current.frame).toEqual(frame)
    await act(async () => {
      await result.current.acquire()
    })
    window.dispatchEvent(new Event("offline"))
    await tick(1000)
    expect(result.current.controlling).toBe(true)
    expect(client.desktopFrame).toHaveBeenCalledTimes(2)
    expect(client.releaseControl).not.toHaveBeenCalled()
  } finally {
    online.mockRestore()
  }
})
