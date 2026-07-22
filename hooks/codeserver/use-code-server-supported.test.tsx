/** @jest-environment jsdom */

import { renderHook, waitFor } from "@testing-library/react"

const supported = jest.fn<Promise<boolean>, []>()

jest.mock("@/lib/codeserver/client", () => ({
  codeServerClient: { supported: () => supported() },
}))
jest.mock("@cognia/logging", () => ({
  createLogger: () => ({ warn: jest.fn() }),
}))

import { useCodeServerSupported } from "./use-code-server-supported"

beforeEach(() => supported.mockReset())

it("distinguishes supported, unsupported, and failed probes", async () => {
  supported.mockResolvedValueOnce(true)
  const first = renderHook(() => useCodeServerSupported(true))
  await waitFor(() => expect(first.result.current).toBe("supported"))
  first.unmount()

  supported.mockResolvedValueOnce(false)
  const second = renderHook(() => useCodeServerSupported(true))
  await waitFor(() => expect(second.result.current).toBe("unsupported"))
  second.unmount()

  supported.mockRejectedValueOnce(new Error("IPC unavailable"))
  const third = renderHook(() => useCodeServerSupported(true))
  await waitFor(() => expect(third.result.current).toBe("error"))
})

it("does not probe when the host is disabled", () => {
  const { result } = renderHook(() => useCodeServerSupported(false))
  expect(result.current).toBe("unsupported")
  expect(supported).not.toHaveBeenCalled()
})
