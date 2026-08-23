/**
 * @jest-environment node
 */

const proxyFetch = jest.fn()
jest.mock("@/lib/network/proxy-fetch", () => ({
  proxyFetch: (...args: [RequestInfo | URL, Record<string, unknown>?]) => proxyFetch(...args),
}))
jest.mock("@cognia/logging", () => ({
  loggers: { network: { warn: jest.fn(), debug: jest.fn() } },
}))

import { fetchIpInfo, IP_INFO_URL } from "./ip-info"

const RAW = JSON.stringify({
  ip: "203.0.113.7",
  city: "Berlin",
  region: "Berlin",
  country: "DE",
  loc: "52.52,13.40",
  org: "AS3320 Deutsche Telekom AG",
  postal: "10115",
  timezone: "Europe/Berlin",
  hostname: "host.example",
})

function respond(status: number, body: string): void {
  proxyFetch.mockResolvedValue({ status, text: () => Promise.resolve(body) })
}

beforeEach(() => {
  proxyFetch.mockReset()
})

describe("fetchIpInfo", () => {
  it("goes through the shared proxy transport with the lookup timeout", async () => {
    respond(200, RAW)

    const res = await fetchIpInfo()

    // One transport, not a hand-rolled Tauri/browser fork: `proxyFetch` is the
    // Rust bridge on the desktop (so the reported IP is the proxy's egress)
    // and the platform `fetch` everywhere else.
    expect(proxyFetch).toHaveBeenCalledWith(IP_INFO_URL, {
      headers: { Accept: "application/json" },
      timeout: 15_000,
    })
    expect(res).toEqual({
      ok: true,
      info: {
        ip: "203.0.113.7",
        city: "Berlin",
        region: "Berlin",
        country: "DE",
        loc: "52.52,13.40",
        org: "AS3320 Deutsche Telekom AG",
        postal: "10115",
        timezone: "Europe/Berlin",
        hostname: "host.example",
      },
    })
  })

  it("reports an error for a non-2xx status", async () => {
    respond(429, "")
    expect(await fetchIpInfo()).toEqual({ ok: false, error: "HTTP 429" })
  })

  it("reports an error for invalid JSON", async () => {
    respond(200, "not json")
    expect(await fetchIpInfo()).toEqual({ ok: false, error: "invalid JSON response" })
  })

  it("reports an error when the payload has no ip", async () => {
    respond(200, JSON.stringify({ city: "x" }))
    expect(await fetchIpInfo()).toEqual({ ok: false, error: "no IP in response" })
  })

  it("returns an error when the response is not an object", async () => {
    respond(200, "42")
    expect(await fetchIpInfo()).toEqual({ ok: false, error: "no IP in response" })
  })

  it("drops blank/non-string optional fields", async () => {
    respond(200, JSON.stringify({ ip: "1.1.1.1", city: "  ", region: 5, org: "AS13335" }))
    expect(await fetchIpInfo()).toEqual({ ok: true, info: { ip: "1.1.1.1", org: "AS13335" } })
  })

  it("resolves to an error result when the transport rejects", async () => {
    // Never throws: the caller renders this in a settings card, and a proxy
    // that is down must not take the panel with it.
    proxyFetch.mockRejectedValue(new Error("Proxy request failed: boom"))
    expect(await fetchIpInfo()).toEqual({ ok: false, error: "Proxy request failed: boom" })
  })
})
