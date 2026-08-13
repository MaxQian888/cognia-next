import { renderHook, act, waitFor } from "@testing-library/react"

jest.mock("@/lib/tauri/notification", () => ({
  checkNotificationPermission: jest.fn(),
  ensureNotificationPermission: jest.fn(),
}))
jest.mock("@/lib/notifications/runtime", () => ({
  refreshOsPermission: jest.fn(),
}))

import { checkNotificationPermission, ensureNotificationPermission } from "@/lib/tauri/notification"
import { refreshOsPermission } from "@/lib/notifications/runtime"
import { useNotificationPermission } from "./use-notification-permission"

const ensure = ensureNotificationPermission as jest.Mock
const check = checkNotificationPermission as jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
  check.mockResolvedValue("default")
})

it("checks the existing permission on mount without prompting", async () => {
  const { result } = renderHook(() => useNotificationPermission())
  expect(result.current.state).toBe("default")
  expect(result.current.granted).toBe(false)
  await waitFor(() => expect(check).toHaveBeenCalledTimes(1))
  expect(ensure).not.toHaveBeenCalled()
})

it("reflects an existing grant without requiring a click", async () => {
  check.mockResolvedValueOnce("granted")
  const { result } = renderHook(() => useNotificationPermission())
  await waitFor(() => expect(result.current.granted).toBe(true))
  expect(ensure).not.toHaveBeenCalled()
  expect(refreshOsPermission).toHaveBeenCalledTimes(1)
})

it("request() prompts, refreshes the runtime cache, and stores the grant", async () => {
  ensure.mockResolvedValueOnce("granted")
  const { result } = renderHook(() => useNotificationPermission())
  await act(async () => {
    const r = await result.current.request()
    expect(r).toBe("granted")
  })
  expect(ensure).toHaveBeenCalledTimes(1)
  expect(refreshOsPermission).toHaveBeenCalledTimes(1)
  await waitFor(() => expect(result.current.granted).toBe(true))
})

it("reflects a denied result", async () => {
  ensure.mockResolvedValueOnce("denied")
  const { result } = renderHook(() => useNotificationPermission())
  await act(async () => {
    await result.current.request()
  })
  await waitFor(() => expect(result.current.state).toBe("denied"))
})
