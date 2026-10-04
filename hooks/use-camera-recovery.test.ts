/** @jest-environment jsdom */
import { renderHook } from "@testing-library/react"
import { toast } from "sonner"
import { useCameraRecovery } from "./use-camera-recovery"
import { subscribeCameraRecovery, type CameraRecoveryResult } from "@/lib/capacitor/camera-recovery"

jest.mock("@/lib/capacitor/camera-recovery", () => ({ subscribeCameraRecovery: jest.fn() }))
jest.mock("sonner", () => ({ toast: { error: jest.fn() } }))
jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

const subscribe = jest.mocked(subscribeCameraRecovery)
const photo: CameraRecoveryResult = { kind: "photo", photo: { base64: "AAAA", format: "png" } }

beforeEach(() => subscribe.mockReset().mockReturnValue(jest.fn()))

it("acknowledges a restored failure with a localized error instead of staging a file", async () => {
  const handler = jest.fn(async () => true)
  renderHook(() => useCameraRecovery({ kind: "chat", id: "session" }, handler))
  await expect(subscribe.mock.calls[0][1]({ kind: "error" }, () => true)).resolves.toBe(true)
  expect(toast.error).toHaveBeenCalledWith("photoFailed")
  expect(handler).not.toHaveBeenCalled()
})

it("waits for a ready target and uses the latest delivery callback", async () => {
  const first = jest.fn(async () => true)
  const second = jest.fn(async () => true)
  const { rerender } = renderHook(
    ({ ready, handler }) =>
      useCameraRecovery(ready ? { kind: "chat", id: "session" } : null, handler),
    { initialProps: { ready: false, handler: first } }
  )
  expect(subscribe).not.toHaveBeenCalled()
  rerender({ ready: true, handler: first })
  expect(subscribe).toHaveBeenCalledTimes(1)
  rerender({ ready: true, handler: second })
  expect(subscribe).toHaveBeenCalledTimes(1)
  await expect(subscribe.mock.calls[0][1](photo, () => true)).resolves.toBe(true)
  expect(first).not.toHaveBeenCalled()
  expect(second).toHaveBeenCalledWith(photo, expect.any(Function))
})

it.each(["switch", "unmount", "scope"])(
  "invalidates asynchronous delivery after %s",
  async (change) => {
    let release!: () => void
    const pause = new Promise<void>((resolve) => {
      release = resolve
    })
    const stage = jest.fn()
    const handler = async (_result: CameraRecoveryResult, isCurrent: () => boolean) => {
      await pause
      if (!isCurrent()) return false
      stage()
      return true
    }
    const { rerender, unmount } = renderHook(
      ({ id }) => useCameraRecovery({ kind: "chat", id }, handler),
      { initialProps: { id: "first" } }
    )
    let scopeCurrent = true
    const pending = subscribe.mock.calls[0][1](photo, () => scopeCurrent)
    if (change === "switch") rerender({ id: "second" })
    else if (change === "unmount") unmount()
    else scopeCurrent = false
    release()
    await expect(pending).resolves.toBe(false)
    expect(stage).not.toHaveBeenCalled()
  }
)

it("removes StrictMode's first subscription and rejects its stale delivery", async () => {
  const remove = jest.fn()
  subscribe.mockReturnValue(remove)
  const handler = jest.fn(async () => true)
  const { unmount } = renderHook(() => useCameraRecovery({ kind: "twin", id: "twin" }, handler), {
    reactStrictMode: true,
  })
  expect(subscribe).toHaveBeenCalledTimes(2)
  expect(remove).toHaveBeenCalledTimes(1)
  await expect(subscribe.mock.calls[0][1](photo, () => true)).resolves.toBe(false)
  expect(handler).not.toHaveBeenCalled()
  unmount()
  expect(remove).toHaveBeenCalledTimes(2)
})
