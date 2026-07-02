/**
 * @jest-environment node
 */

jest.mock("@tauri-apps/api/core", () => ({ invoke: jest.fn() }))
jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn() }))
jest.mock("@/lib/logging", () => ({
  loggers: { network: { warn: jest.fn(), debug: jest.fn() } },
}))

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { invoke } = require("@tauri-apps/api/core") as { invoke: jest.Mock }
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { isTauri } = require("@/lib/tauri") as { isTauri: jest.Mock }

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

beforeEach(() => {
  jest.clearAllMocks()
})

describe("fetchIpInfo (Tauri path)", () => {
  beforeEach(() => isTauri.mockReturnValue(true))

  it("routes through proxy_http_request and normalizes the payload", async () => {
    invoke.mockResolvedValue({ status: 200, body: RAW, headers: {} })
    const res = await fetchIpInfo()
    expect(invoke).toHaveBeenCalledWith(
      "proxy_http_request",
      expect.objectContaining({
        input: expect.objectContaining({ url: IP_INFO_URL, method: "GET" }),
      })
    )
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
    invoke.mockResolvedValue({ status: 429, body: "", headers: {} })
    expect(await fetchIpInfo()).toEqual({ ok: false, error: "HTTP 429" })
  })

  it("reports an error for invalid JSON", async () => {
    invoke.mockResolvedValue({ status: 200, body: "not json", headers: {} })
    expect(await fetchIpInfo()).toEqual({ ok: false, error: "invalid JSON response" })
  })

  it("reports an error when the payload has no ip", async () => {
    invoke.mockResolvedValue({ status: 200, body: JSON.stringify({ city: "x" }), headers: {} })
    expect(await fetchIpInfo()).toEqual({ ok: false, error: "no IP in response" })
  })

  it("drops blank/non-string optional fields", async () => {
    invoke.mockResolvedValue({
      status: 200,
      body: JSON.stringify({ ip: "1.1.1.1", city: "  ", region: 5, org: "AS13335" }),
      headers: {},
    })
    const res = await fetchIpInfo()
    expect(res).toEqual({ ok: true, info: { ip: "1.1.1.1", org: "AS13335" } })
  })

  it("resolves to an error when invoke throws", async () => {
    invoke.mockRejectedValue(new Error("boom"))
    expect(await fetchIpInfo()).toEqual({ ok: false, error: "boom" })
  })

  it("returns an error when the response is not an object", async () => {
    invoke.mockResolvedValue({ status: 200, body: "42", headers: {} })
    expect(await fetchIpInfo()).toEqual({ ok: false, error: "no IP in response" })
  })
})

describe("fetchIpInfo (browser path)", () => {
  beforeEach(() => isTauri.mockReturnValue(false))
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
  })

  it("uses fetch and returns normalized info", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      status: 200,
      text: () => Promise.resolve(JSON.stringify({ ip: "8.8.8.8", country: "US" })),
    }) as unknown as typeof fetch
    const res = await fetchIpInfo()
    expect(global.fetch).toHaveBeenCalledWith(IP_INFO_URL, expect.objectContaining({}))
    expect(res).toEqual({ ok: true, info: { ip: "8.8.8.8", country: "US" } })
    expect(invoke).not.toHaveBeenCalled()
  })

  it("surfaces a fetch rejection as an error result", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch
    expect(await fetchIpInfo()).toEqual({ ok: false, error: "network down" })
  })
})
