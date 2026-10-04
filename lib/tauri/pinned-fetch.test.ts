/**
 * Tests for pinned-fetch (P0.2 / M2.9).
 *
 * Runs under Jest (jsdom). We toggle a fake `Capacitor` global on/off to
 * exercise the native-path branch vs. the platform-`fetch` fallback.
 */

import {
  isPinnedRouteUnavailable,
  NativePinningUnavailableError,
  nativeSpkiPinningAttested,
  pinnedFetch,
  usesNativePinnedRoute,
} from "./pinned-fetch"

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

  it.each(["buffer", "slice", "blob", "form"])(
    "serializes %s bodies as native-decoded bytes",
    async (kind) => {
      const raw = new Uint8Array([0, 255, 128, 1])
      const form = new FormData()
      form.append("note", "你好")
      form.append("file", new Blob([raw]), "data.bin")
      const body =
        kind === "buffer"
          ? raw.buffer
          : kind === "slice"
            ? raw.subarray(1, 3)
            : kind === "blob"
              ? new Blob([raw])
              : form
      let nativeBytes: Uint8Array | undefined
      let nativeHeaders: Record<string, string> = {}
      const request = jest.fn(async (options) => {
        expect(options.dataType).toBe("file")
        nativeBytes = Uint8Array.from(atob(options.data), (c) => c.charCodeAt(0))
        nativeHeaders = options.headers
        return { status: 200, headers: {}, data: "" }
      })
      ;(globalThis as unknown as { Capacitor: unknown }).Capacitor = {
        isNativePlatform: () => true,
        Plugins: { CapacitorHttp: { request } },
      }
      await pinnedFetch("https://test.trycloudflare.com/content", { method: "POST", body })
      if (kind === "form") {
        const decoded = await new Response(nativeBytes as Uint8Array<ArrayBuffer>, {
          headers: nativeHeaders,
        }).formData()
        expect(decoded.get("note")).toBe("你好")
        expect(new Uint8Array(await (decoded.get("file") as File).arrayBuffer())).toEqual(raw)
      } else expect(nativeBytes).toEqual(kind === "slice" ? raw.subarray(1, 3) : raw)
    }
  )

  it("decodes native base64 media responses without UTF-8 corruption", async () => {
    const request = jest.fn(async () => ({
      status: 200,
      headers: { "Content-Type": "image/png" },
      data: "AP+AAQ==",
    }))
    ;(globalThis as unknown as { Capacitor: unknown }).Capacitor = {
      isNativePlatform: () => true,
      Plugins: { CapacitorHttp: { request } },
    }
    const response = await pinnedFetch("https://test.trycloudflare.com/content", {
      binaryResponse: true,
    })
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ responseType: "blob" }))
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([0, 255, 128, 1]))
  })

  it("preserves native-parsed JSON error strings on binary requests", async () => {
    const request = jest.fn(async () => ({
      status: 403,
      headers: { "Content-Type": "application/json" },
      data: "denied",
    }))
    ;(globalThis as unknown as { Capacitor: unknown }).Capacitor = {
      isNativePlatform: () => true,
      Plugins: { CapacitorHttp: { request } },
    }
    const response = await pinnedFetch("https://test.trycloudflare.com/content", {
      binaryResponse: true,
    })
    expect(response.ok).toBe(false)
    expect(await response.json()).toBe("denied")
  })

  it("does not decode a forbidden response body on a 204", async () => {
    const request = jest.fn(async () => ({ status: 204, headers: {}, data: "not base64" }))
    ;(globalThis as unknown as { Capacitor: unknown }).Capacitor = {
      isNativePlatform: () => true,
      Plugins: { CapacitorHttp: { request } },
    }
    const response = await pinnedFetch("https://test.trycloudflare.com/content", {
      binaryResponse: true,
    })
    expect(await response.text()).toBe("")
    expect((await response.arrayBuffer()).byteLength).toBe(0)
  })

  it("never dispatches an already-cancelled native request", async () => {
    const request = jest.fn()
    ;(globalThis as unknown as { Capacitor: unknown }).Capacitor = {
      isNativePlatform: () => true,
      Plugins: { CapacitorHttp: { request } },
    }
    const controller = new AbortController()
    controller.abort()
    await expect(
      pinnedFetch("https://example.test", { signal: controller.signal })
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(request).not.toHaveBeenCalled()
  })

  it("rejects cancelled native work and discards its late result", async () => {
    let resolve!: (response: unknown) => void
    const request = jest.fn(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    ;(globalThis as unknown as { Capacitor: unknown }).Capacitor = {
      isNativePlatform: () => true,
      Plugins: { CapacitorHttp: { request } },
    }
    const controller = new AbortController()
    const pending = pinnedFetch("https://example.test", { signal: controller.signal })
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" })
    await new Promise((done) => setTimeout(done, 0))
    controller.abort()
    await rejected
    resolve({ status: 200, headers: {}, data: "late" })
  })

  it("cancels pending pin attestation without dispatching later", async () => {
    let attest!: (value: { spkiPinning: boolean }) => void
    const request = jest.fn()
    ;(globalThis as unknown as { Capacitor: unknown }).Capacitor = {
      isNativePlatform: () => true,
      Plugins: {
        CapacitorHttp: {
          request,
          getSecurityCapabilities: () =>
            new Promise((resolve) => {
              attest = resolve
            }),
        },
      },
    }
    const controller = new AbortController()
    const pending = pinnedFetch("https://192.168.1.42/x", {
      signal: controller.signal,
      serverFingerprint: "abc",
    })
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" })
    controller.abort()
    await rejected
    attest({ spkiPinning: true })
    await Promise.resolve()
    expect(request).not.toHaveBeenCalled()
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
      url: "https://192.168.1.42:7890/api/whoami",
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

    const r = await pinnedFetch("https://192.168.1.42:7890/api/whoami", {
      method: "GET",
      serverFingerprint: "deadbeef",
    })

    expect(r.status).toBe(200)
    expect(request).toHaveBeenCalledTimes(1)
    const arg = (request as unknown as jest.Mock).mock.calls[0][0] as Record<string, unknown>
    expect(arg.serverTrustMode).toBe("pinned")
    expect(arg.serverFingerprint).toBe("deadbeef")
    expect(arg.url).toBe("https://192.168.1.42:7890/api/whoami")
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

  it("fails closed with a typed error when the plugin proxy rejects the attestation", async () => {
    // A Capacitor plugin proxy returns a function for every property name, so
    // an attestation the native side never registered is a call that rejects
    // ("not implemented on android"), not `undefined`. Stock Android does this.
    const request = jest.fn()
    ;(globalThis as unknown as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      Plugins: {
        CapacitorHttp: {
          request,
          getSecurityCapabilities: () =>
            Promise.reject(
              new Error('"CapacitorHttp.getSecurityCapabilities()" is not implemented on android')
            ),
        },
      },
    }

    const error = await pinnedFetch("https://192.168.1.42:7890/api/_rpc/x", {
      serverFingerprint: "deadbeef",
    }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(NativePinningUnavailableError)
    expect((error as NativePinningUnavailableError).code).toBe("native_spki_pinning_unavailable")
    expect(request).not.toHaveBeenCalled()
  })

  it("asks the native side for its attestation once per plugin", async () => {
    const getSecurityCapabilities = jest.fn(async () => ({ spkiPinning: true }))
    const plugin = { request: jest.fn(), getSecurityCapabilities }

    await expect(nativeSpkiPinningAttested(plugin)).resolves.toBe(true)
    await expect(nativeSpkiPinningAttested(plugin)).resolves.toBe(true)
    expect(getSecurityCapabilities).toHaveBeenCalledTimes(1)
    await expect(nativeSpkiPinningAttested(null)).resolves.toBe(false)
    await expect(nativeSpkiPinningAttested({ request: jest.fn() })).resolves.toBe(false)
  })

  it("reports the pinned route as unavailable only where pinnedFetch would refuse it", async () => {
    const lan = "https://192.168.1.42:7890/api/_rpc/x"
    const tunnel = "https://abc.trycloudflare.com/api/_rpc/x"
    expect(usesNativePinnedRoute(lan, "deadbeef")).toBe(false)
    await expect(isPinnedRouteUnavailable(lan, "deadbeef")).resolves.toBe(false)

    ;(globalThis as unknown as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      Plugins: {
        CapacitorHttp: {
          request: jest.fn(),
          getSecurityCapabilities: async () => ({ spkiPinning: false }),
        },
      },
    }
    expect(usesNativePinnedRoute(lan, "deadbeef")).toBe(true)
    await expect(isPinnedRouteUnavailable(lan, "deadbeef")).resolves.toBe(true)
    // Tunnel hosts and unpinned requests never ask for pinning.
    expect(usesNativePinnedRoute(tunnel, "deadbeef")).toBe(false)
    await expect(isPinnedRouteUnavailable(tunnel, "deadbeef")).resolves.toBe(false)
    await expect(isPinnedRouteUnavailable(lan, undefined)).resolves.toBe(false)
  })

  it("uses default trust mode for trycloudflare hosts", async () => {
    const request = jest.fn(async () => ({
      data: "{}",
      status: 200,
      headers: {},
      url: "https://abc-def-ghi.trycloudflare.com/api/whoami",
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

    await pinnedFetch("https://abc-def-ghi.trycloudflare.com/api/whoami", {
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
      url: "https://192.168.1.42:7890/api/auth/device/register",
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

    await pinnedFetch("https://192.168.1.42:7890/api/auth/device/register", { method: "POST" })

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
