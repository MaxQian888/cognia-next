/**
 * Tests for pinned-fetch (P0.2 / M2.9).
 *
 * Runs under Jest (jsdom). We toggle a fake `Capacitor` global on/off to
 * exercise the native-path branch vs. the platform-`fetch` fallback.
 */

import { pinnedFetch } from "./pinned-fetch"

describe("pinnedFetch", () => {
  const originalFetch = globalThis.fetch
  const originalCapacitor = (globalThis as unknown as { Capacitor?: unknown }).Capacitor

  beforeEach(() => {
    delete (globalThis as unknown as { Capacitor?: unknown }).Capacitor
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    if (originalCapacitor === undefined) {
      delete (globalThis as unknown as { Capacitor?: unknown }).Capacitor
    } else {
      ;(globalThis as unknown as { Capacitor?: unknown }).Capacitor = originalCapacitor
    }
  })

  it("delegates to global fetch when not running in Capacitor", async () => {
    const fakeResp = { ok: true, status: 200, json: async () => ({ ok: true }) } as Response
    globalThis.fetch = jest.fn(async () => fakeResp) as unknown as typeof fetch

    const r = await pinnedFetch("https://example.com/api", {
      method: "POST",
      body: "{}",
      serverFingerprint: "abc",
    })
    expect(await r.json()).toEqual({ ok: true })
    const callArgs = (globalThis.fetch as unknown as jest.Mock).mock.calls[0][1] as Record<
      string,
      unknown
    >
    expect(callArgs).not.toHaveProperty("serverFingerprint")
  })

  it("routes through CapacitorHttp with strict SPKI pinning for paired LAN URLs", async () => {
    const request = jest.fn(async () => ({
      data: '{"hi":"there"}',
      status: 200,
      headers: { "content-type": "application/json" },
      url: "https://192.168.1.42:7890/api/v1/whoami",
    }))
    ;(globalThis as unknown as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      Plugins: {
        CapacitorHttp: {
          request,
          getSecurityCapabilities: async () => ({ spkiPinning: true }),
        },
      },
    }

    const r = await pinnedFetch("https://192.168.1.42:7890/api/v1/whoami", {
      method: "GET",
      serverFingerprint: "deadbeef",
    })

    expect(r.status).toBe(200)
    expect(request).toHaveBeenCalledTimes(1)
    const arg = (request as unknown as jest.Mock).mock.calls[0][0] as Record<string, unknown>
    expect(arg.serverTrustMode).toBe("pinned")
    expect(arg.serverFingerprint).toBe("deadbeef")
    expect(arg.url).toBe("https://192.168.1.42:7890/api/v1/whoami")
  })

  it("fails closed when the native plugin cannot attest SPKI enforcement", async () => {
    const request = jest.fn()
    ;(globalThis as unknown as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      Plugins: { CapacitorHttp: { request } },
    }

    await expect(
      pinnedFetch("https://192.168.1.42:7890/api/v2/devices", {
        serverFingerprint: "deadbeef",
      })
    ).rejects.toThrow("native_spki_pinning_unavailable")
    expect(request).not.toHaveBeenCalled()
  })

  it("uses default trust mode for trycloudflare hosts", async () => {
    const request = jest.fn(async () => ({
      data: "{}",
      status: 200,
      headers: {},
      url: "https://abc-def-ghi.trycloudflare.com/api/v1/whoami",
    }))
    ;(globalThis as unknown as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      Plugins: {
        CapacitorHttp: {
          request,
          getSecurityCapabilities: async () => ({ spkiPinning: true }),
        },
      },
    }

    await pinnedFetch("https://abc-def-ghi.trycloudflare.com/api/v1/whoami", {
      serverFingerprint: "deadbeef",
    })

    const arg = (request as unknown as jest.Mock).mock.calls[0][0] as Record<string, unknown>
    expect(arg.serverTrustMode).toBe("default")
  })

  it("uses default trust mode when no fingerprint is provided", async () => {
    const request = jest.fn(async () => ({
      data: "{}",
      status: 200,
      headers: {},
      url: "https://192.168.1.42:7890/api/v1/auth/pair/issue",
    }))
    ;(globalThis as unknown as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      Plugins: {
        CapacitorHttp: {
          request,
          getSecurityCapabilities: async () => ({ spkiPinning: true }),
        },
      },
    }

    await pinnedFetch("https://192.168.1.42:7890/api/v1/auth/pair/issue", { method: "POST" })

    const arg = (request as unknown as jest.Mock).mock.calls[0][0] as Record<string, unknown>
    expect(arg.serverTrustMode).toBe("default")
  })

  it("normalizes Headers object into a plain record for CapacitorHttp", async () => {
    const request = jest.fn(async () => ({
      data: "{}",
      status: 200,
      headers: {},
      url: "https://192.168.1.42:7890/x",
    }))
    ;(globalThis as unknown as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      Plugins: {
        CapacitorHttp: {
          request,
          getSecurityCapabilities: async () => ({ spkiPinning: true }),
        },
      },
    }

    const h = new Headers()
    h.set("X-Test", "yes")
    h.set("Authorization", "Bearer tok")
    await pinnedFetch("https://192.168.1.42:7890/x", {
      headers: h,
      serverFingerprint: "abc",
    })

    const arg = (request as unknown as jest.Mock).mock.calls[0][0] as {
      headers: Record<string, string>
    }
    expect(arg.headers["x-test"]).toBe("yes")
    expect(arg.headers["authorization"]).toBe("Bearer tok")
  })

  it("returns JSON-stringified Response body when CapacitorHttp returned object data", async () => {
    const request = jest.fn(async () => ({
      data: { kind: "object" },
      status: 200,
      headers: {},
      url: "https://192.168.1.42:7890/x",
    }))
    ;(globalThis as unknown as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      Plugins: {
        CapacitorHttp: {
          request,
          getSecurityCapabilities: async () => ({ spkiPinning: true }),
        },
      },
    }

    const r = await pinnedFetch("https://192.168.1.42:7890/x", { serverFingerprint: "abc" })
    expect(await r.json()).toEqual({ kind: "object" })
  })

  it("falls back to global fetch when Capacitor reports non-native platform", async () => {
    ;(globalThis as unknown as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => false,
      Plugins: { CapacitorHttp: { request: jest.fn() } },
    }
    const fakeResp = { ok: true, status: 200, text: async () => "hi" } as Response
    globalThis.fetch = jest.fn(async () => fakeResp) as unknown as typeof fetch

    const r = await pinnedFetch("http://localhost:3000/x")
    expect(await r.text()).toBe("hi")
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })
})
