/** @jest-environment jsdom */

import {
  isBrowserTrustableOrigin,
  isLoopbackHostname,
  probeOriginReachable,
} from "./origin-reachability"

const never = new AbortController().signal

describe("probeOriginReachable", () => {
  it("reports a peer that answers, even when the answer is unreadable", async () => {
    // The whole point: a `no-cors` request resolves opaquely whatever the
    // status was, so a 403 with no CORS headers still proves someone is home.
    const fetchImpl = jest.fn().mockResolvedValue({ type: "opaque" } as Response)
    await expect(
      probeOriginReachable("http://127.0.0.1:27891", { signal: never, fetchImpl })
    ).resolves.toBe(true)
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:27891/healthz",
      expect.objectContaining({ mode: "no-cors", credentials: "omit", cache: "no-store" })
    )
  })

  it("reports nothing listening when the connection never completes", async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new TypeError("Failed to fetch"))
    await expect(
      probeOriginReachable("https://192.168.1.42:27890", { signal: never, fetchImpl })
    ).resolves.toBe(false)
  })

  it("trims a trailing slash and honours a custom path", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({} as Response)
    await probeOriginReachable("http://127.0.0.1:27891/", {
      signal: never,
      fetchImpl,
      path: "/api/auth/config",
    })
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:27891/api/auth/config",
      expect.anything()
    )
  })

  it("does not dispatch once the caller has aborted", async () => {
    const fetchImpl = jest.fn()
    const aborted = AbortSignal.abort()
    await expect(
      probeOriginReachable("http://127.0.0.1:27891", { signal: aborted, fetchImpl })
    ).resolves.toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe("isBrowserTrustableOrigin", () => {
  it.each([
    ["http://127.0.0.1:27891", true],
    ["http://localhost:27891", true],
    ["http://[::1]:27891", true],
    ["https://localhost:8443", true],
    ["https://cognia.example.com", true],
    ["https://cognia.example.com:8443", true],
  ])("accepts %s", (url, expected) => {
    expect(isBrowserTrustableOrigin(url)).toBe(expected)
  })

  it.each([
    // Self-signed by construction: no CA issues a certificate for a bare LAN
    // IP literal or an mDNS name, so the browser handshake cannot complete.
    ["https://192.168.1.42:27890", false],
    ["https://10.0.0.5:27890", false],
    ["https://cognia-desktop.local:27890", false],
    // Plaintext off-machine is not "untrusted", it is unencrypted.
    ["http://192.168.1.42:27891", false],
    ["not a url", false],
  ])("rejects %s", (url, expected) => {
    expect(isBrowserTrustableOrigin(url)).toBe(expected)
  })
})

describe("isLoopbackHostname", () => {
  it.each(["localhost", "127.0.0.1", "127.1.2.3", "::1", "[::1]"])("accepts %s", (host) => {
    expect(isLoopbackHostname(host)).toBe(true)
  })

  it("does not accept a suffix that merely ends in localhost", () => {
    expect(isLoopbackHostname("localhost.evil.example")).toBe(false)
    expect(isLoopbackHostname("192.168.1.42")).toBe(false)
  })
})
