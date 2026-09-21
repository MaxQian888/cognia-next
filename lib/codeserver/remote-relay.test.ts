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
  ensureRemotePortRelay,
  ensureLocalPortRelay,
  stopRemotePortRelay,
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
    devicePrivateKeyJwk: ENDPOINT.devicePrivateKeyJwk,
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
  await jest.advanceTimersByTimeAsync(10_000)

  expect(call).toHaveBeenCalledTimes(2)
  expect(call).toHaveBeenLastCalledWith("codeserver_remote_relay_ensure", {
    baseUrl: ENDPOINT.baseUrl,
    deviceJwt: "token-2",
    devicePrivateKeyJwk: ENDPOINT.devicePrivateKeyJwk,
    serverFingerprint: ENDPOINT.serverFingerprint,
    relayPath: RELAY_PATH,
  })
})

it("keeps refreshing after one refresh fails", async () => {
  // A single miss is still inside the old token's lifetime, so the loop must
  // not disarm itself over it.
  await ensureRemoteIdeRelay(ENDPOINT, RELAY_PATH)
  mockAuthHeaders.mockResolvedValue({ Authorization: "Bearer token-2" })
  call.mockRejectedValueOnce(new Error("host briefly unreachable"))

  await jest.advanceTimersByTimeAsync(10_000)
  expect(call).toHaveBeenCalledTimes(2)

  await jest.advanceTimersByTimeAsync(10_000)
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
  mockAuthHeaders.mockClear()

  await jest.advanceTimersByTimeAsync(10_000)
  expect(mockAuthHeaders).toHaveBeenCalledTimes(1)
  expect(call).not.toHaveBeenCalled()
})

it("stops refreshing once the relay is torn down", async () => {
  await ensureRemoteIdeRelay(ENDPOINT, RELAY_PATH)
  stopRemoteIdeRelayRefresh()
  expect(isRemoteIdeRelayActive()).toBe(false)
  call.mockClear()

  await jest.advanceTimersByTimeAsync(10 * 60 * 1000)
  expect(call).not.toHaveBeenCalled()
})

it("keeps two port relay refreshes separate from the IDE", async () => {
  await ensureRemoteIdeRelay(ENDPOINT, RELAY_PATH)
  await ensureRemotePortRelay(ENDPOINT, "/api/environment/ports/p/c/3000/", "port-1")
  await ensureRemotePortRelay(ENDPOINT, "/api/environment/ports/p/c/4000/", "port-2")
  await stopRemotePortRelay("port-1")
  call.mockClear()
  mockAuthHeaders.mockResolvedValue({ Authorization: "Bearer token-2" })
  await jest.advanceTimersByTimeAsync(10_000)
  const ids = call.mock.calls.map(([, args]) => args.relayId)
  expect(ids).toContain(undefined)
  expect(ids).toContain("port-2")
  expect(ids).not.toContain("port-1")
  expect(isRemoteIdeRelayActive()).toBe(true)
  await stopRemotePortRelay("port-2")
})

it("orders stop after an outstanding bind so a cancelled opening cannot leak", async () => {
  let finish!: (status: unknown) => void
  call.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const opening = ensureRemotePortRelay(
    ENDPOINT,
    "/api/environment/ports/p/c/3000/",
    "pending-port"
  )
  await jest.advanceTimersByTimeAsync(0)
  const closing = stopRemotePortRelay("pending-port")
  expect(call).not.toHaveBeenCalledWith("codeserver_remote_relay_stop", expect.anything())
  finish({ port: 51234, url: "http://127.0.0.1:51234/" })
  await opening
  await closing
  expect(call).toHaveBeenLastCalledWith("codeserver_remote_relay_stop", { relayId: "pending-port" })
})

it("binds a local port without inventing a remote credential", async () => {
  const localPort = { projectId: "p", containerId: "c", port: 3000 }
  await ensureLocalPortRelay(localPort, "local-port")
  expect(call).toHaveBeenCalledWith("codeserver_remote_relay_ensure", {
    relayId: "local-port",
    localPort,
  })
  expect(mockAuthHeaders).not.toHaveBeenCalled()
  await stopRemotePortRelay("local-port")
})

it.each([undefined, { kty: "EC", crv: "P-256" }, { kty: "EC", crv: "P-256", d: "" }])(
  "refuses a remote relay without its private signing key (%p)",
  async (devicePrivateKeyJwk) => {
    // Exercise malformed persisted pairing data at the runtime boundary.
    const endpoint = { ...ENDPOINT, devicePrivateKeyJwk } as RemoteHostEndpoint
    await expect(ensureRemoteIdeRelay(endpoint, RELAY_PATH)).rejects.toThrow(
      "missing its paired device signing key"
    )
    expect(call).not.toHaveBeenCalled()
    expect(mockAuthHeaders).not.toHaveBeenCalled()
    expect(isRemoteIdeRelayActive()).toBe(false)
  }
)

it.each(["IDE", "port"])(
  "renews a cached five-minute token before expiry for %s and retries failures",
  async (kind) => {
    const started = Date.now()
    let expiresAt = started + 300_000
    let bearer = "token-1"
    let attempts = 0
    mockAuthHeaders.mockImplementation(async () => {
      // The actual companion auth cache refreshes only inside its 30s window.
      if (expiresAt - Date.now() < 30_000) {
        attempts += 1
        if (attempts === 1) throw new Error("temporary token endpoint outage")
        bearer = "token-2"
        expiresAt = Date.now() + 300_000
      }
      return { Authorization: `Bearer ${bearer}` }
    })
    if (kind === "IDE") await ensureRemoteIdeRelay(ENDPOINT, RELAY_PATH)
    else await ensureRemotePortRelay(ENDPOINT, "/api/environment/ports/p/c/3000/", "expiry-port")
    await jest.advanceTimersByTimeAsync(270_000)
    expect(call).toHaveBeenCalledTimes(1) // Cached credentials do not cause repeated IPC.
    await jest.advanceTimersByTimeAsync(10_000)
    expect(attempts).toBe(1)
    expect(call).toHaveBeenCalledTimes(1)
    await jest.advanceTimersByTimeAsync(10_000)
    expect(attempts).toBe(2)
    expect(Date.now()).toBeLessThan(started + 300_000)
    expect(call).toHaveBeenCalledTimes(2)
    expect(call).toHaveBeenLastCalledWith(
      "codeserver_remote_relay_ensure",
      expect.objectContaining({ deviceJwt: "token-2" })
    )
    if (kind === "port") await stopRemotePortRelay("expiry-port")
  }
)

it("coalesces concurrent port token requests for the same pairing", async () => {
  let finish!: (value: { Authorization: string }) => void
  mockAuthHeaders.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const first = ensureRemotePortRelay(ENDPOINT, "/api/environment/ports/p/c/3000/", "coalesced-1")
  const second = ensureRemotePortRelay(
    { ...ENDPOINT },
    "/api/environment/ports/p/c/4000/",
    "coalesced-2"
  )
  await jest.advanceTimersByTimeAsync(0)
  expect(mockAuthHeaders).toHaveBeenCalledTimes(1)
  finish({ Authorization: "Bearer shared-token" })
  await Promise.all([first, second])
  expect(call).toHaveBeenCalledTimes(2)
  mockAuthHeaders.mockClear().mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  await jest.advanceTimersByTimeAsync(10_000)
  expect(mockAuthHeaders).toHaveBeenCalledTimes(1)
  // Slow refresh cannot stack a second request on subsequent ticks either.
  await jest.advanceTimersByTimeAsync(20_000)
  expect(mockAuthHeaders).toHaveBeenCalledTimes(1)
  finish({ Authorization: "Bearer rotated-token" })
  await jest.advanceTimersByTimeAsync(0)
  expect(call).toHaveBeenCalledTimes(4)
  await Promise.all([stopRemotePortRelay("coalesced-1"), stopRemotePortRelay("coalesced-2")])
})
