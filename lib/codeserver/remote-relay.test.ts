jest.mock("@/lib/tauri", () => ({ transport: { call: jest.fn() } }))

const mockAuthHeaders = jest.fn(async () => ({ Authorization: "Bearer token-1" }))
jest.mock("@/lib/tauri/companion-auth", () => ({
  companionAuthorizationHeaders: (...args: unknown[]) => mockAuthHeaders(...(args as [])),
}))

import { transport } from "@/lib/tauri"
import type { RemoteHostEndpoint } from "@/lib/tauri/transport-routing"

import {
  __resetRemoteIdeRelayForTesting,
  ensureRemoteIdeRelay,
  isRemoteIdeRelayActive,
  stopRemoteIdeRelayRefresh,
} from "./remote-relay"

const call = transport.call as jest.Mock

const ENDPOINT: RemoteHostEndpoint = {
  baseUrl: "https://remote.example:27890",
  deviceId: "device-1",
  devicePrivateKeyJwk: { kty: "EC", crv: "P-256", d: "device-private" },
  deviceKeyThumbprint: "device-thumbprint",
  serverVersion: "1.0.0",
  serverFingerprint: "ab".repeat(32),
}

const RELAY_PATH = "/ide/relay/opaque/"

beforeEach(() => {
  jest.useFakeTimers()
  __resetRemoteIdeRelayForTesting()
  mockAuthHeaders.mockReset().mockResolvedValue({ Authorization: "Bearer token-1" })
  call.mockReset().mockResolvedValue({ port: 51234, url: "http://127.0.0.1:51234/" })
})

afterEach(() => {
  __resetRemoteIdeRelayForTesting()
  jest.useRealTimers()
})

it("binds the loopback relay with a freshly minted device token", async () => {
  await expect(ensureRemoteIdeRelay(ENDPOINT, RELAY_PATH)).resolves.toEqual({
    port: 51234,
    url: "http://127.0.0.1:51234/",
  })

  expect(call).toHaveBeenCalledWith("codeserver_remote_relay_ensure", {
    baseUrl: ENDPOINT.baseUrl,
    deviceJwt: "token-1",
    serverFingerprint: ENDPOINT.serverFingerprint,
    relayPath: RELAY_PATH,
  })
})

it("refuses to bind without a pinned certificate fingerprint", async () => {
  // Without the pin the relay would trust any certificate on the way to the
  // host, which is the whole reason the relay exists instead of navigating the
  // webview at the host directly.
  const { serverFingerprint: _omitted, ...unpinned } = ENDPOINT
  await expect(ensureRemoteIdeRelay(unpinned, RELAY_PATH)).rejects.toThrow(
    "missing its paired certificate fingerprint"
  )
  expect(call).not.toHaveBeenCalled()
  expect(isRemoteIdeRelayActive()).toBe(false)
})

it("rejects when the host will not issue a device access token", async () => {
  mockAuthHeaders.mockResolvedValue({} as { Authorization: string })
  await expect(ensureRemoteIdeRelay(ENDPOINT, RELAY_PATH)).rejects.toThrow(
    "did not issue a device access token"
  )
  expect(call).not.toHaveBeenCalled()
})

it("re-mints the credential before the five-minute token expiry", async () => {
  // The relay holds one bearer at a time and device access tokens live five
  // minutes; without this the workbench starts 401ing mid-session.
  await ensureRemoteIdeRelay(ENDPOINT, RELAY_PATH)
  expect(call).toHaveBeenCalledTimes(1)

  mockAuthHeaders.mockResolvedValue({ Authorization: "Bearer token-2" })
  await jest.advanceTimersByTimeAsync(3.5 * 60 * 1000)

  expect(call).toHaveBeenCalledTimes(2)
  expect(call).toHaveBeenLastCalledWith("codeserver_remote_relay_ensure", {
    baseUrl: ENDPOINT.baseUrl,
    deviceJwt: "token-2",
    serverFingerprint: ENDPOINT.serverFingerprint,
    relayPath: RELAY_PATH,
  })
})

it("keeps refreshing after one refresh fails", async () => {
  // A single miss is still inside the old token's lifetime, so the loop must
  // not disarm itself over it.
  await ensureRemoteIdeRelay(ENDPOINT, RELAY_PATH)
  call.mockRejectedValueOnce(new Error("host briefly unreachable"))

  await jest.advanceTimersByTimeAsync(3.5 * 60 * 1000)
  expect(call).toHaveBeenCalledTimes(2)

  await jest.advanceTimersByTimeAsync(3.5 * 60 * 1000)
  expect(call).toHaveBeenCalledTimes(3)
  expect(isRemoteIdeRelayActive()).toBe(true)
})

it("arms no timer when the very first bind fails", async () => {
  call.mockRejectedValueOnce(new Error("bind refused"))
  await expect(ensureRemoteIdeRelay(ENDPOINT, RELAY_PATH)).rejects.toThrow("bind refused")

  expect(isRemoteIdeRelayActive()).toBe(false)
  await jest.advanceTimersByTimeAsync(10 * 60 * 1000)
  expect(call).toHaveBeenCalledTimes(1)
})

it("replaces the armed timer instead of stacking one per ensure", async () => {
  await ensureRemoteIdeRelay(ENDPOINT, RELAY_PATH)
  await ensureRemoteIdeRelay(ENDPOINT, RELAY_PATH)
  call.mockClear()

  await jest.advanceTimersByTimeAsync(3.5 * 60 * 1000)
  expect(call).toHaveBeenCalledTimes(1)
})

it("stops refreshing once the relay is torn down", async () => {
  await ensureRemoteIdeRelay(ENDPOINT, RELAY_PATH)
  stopRemoteIdeRelayRefresh()
  expect(isRemoteIdeRelayActive()).toBe(false)
  call.mockClear()

  await jest.advanceTimersByTimeAsync(10 * 60 * 1000)
  expect(call).not.toHaveBeenCalled()
})
