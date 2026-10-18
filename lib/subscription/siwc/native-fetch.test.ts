const mockInvoke = jest.fn()
const mockIsTauri = jest.fn(() => true)
jest.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => mockInvoke(...args) }))
jest.mock("@/lib/tauri", () => ({ isTauri: () => mockIsTauri() }))

import { createNativeSiwcFetch, encodeSiwcReference } from "./native-fetch"

beforeEach(() => {
  mockInvoke.mockReset()
  mockIsTauri.mockReturnValue(true)
})

it("passes only an explicit connection reference and body to native streaming commands", async () => {
  mockInvoke.mockImplementation(async (command: string) => {
    if (command === "siwc_responses_open") return { streamId: "s", status: 200, headers: {} }
    if (command === "siwc_responses_read") return { done: true }
    return null
  })
  const fetch = createNativeSiwcFetch(
    encodeSiwcReference({ localAccountId: "a", connectionId: "c" })
  )
  const response = await fetch("https://siwc.cognia.invalid/v1/responses", {
    method: "POST",
    body: "{}",
  })
  expect(await response.text()).toBe("")
  expect(mockInvoke).toHaveBeenCalledWith("siwc_responses_open", {
    localAccountId: "a",
    connectionId: "c",
    requestId: expect.any(String),
    body: "{}",
  })
})

it("refuses web execution and invalid references before native calls", () => {
  mockIsTauri.mockReturnValue(false)
  expect(() => createNativeSiwcFetch("siwc://a/c")).toThrow(/native/)
  mockIsTauri.mockReturnValue(true)
  expect(() => createNativeSiwcFetch("https://relay.invalid")).toThrow(/SIWC/)
  expect(mockInvoke).not.toHaveBeenCalled()
})
