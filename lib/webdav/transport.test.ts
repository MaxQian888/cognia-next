import { WebDavError } from "./errors"

let isTauriValue = false
let capPlugin: { request: jest.Mock } | null = null
const connectorsHttpRequestMock = jest.fn()

jest.mock("@/lib/tauri", () => ({ isTauri: () => isTauriValue }))
jest.mock("@/lib/connectivity/capacitor-http", () => ({ getCapacitorHttp: () => capPlugin }))
jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsHttpRequest: (...args: unknown[]) => connectorsHttpRequestMock(...args),
}))

// Imported after mocks are registered.
import { createWebDavTransport, isWebDavSupported } from "./transport"

beforeEach(() => {
  isTauriValue = false
  capPlugin = null
  connectorsHttpRequestMock.mockReset()
})

describe("createWebDavTransport", () => {
  it("throws on web (no Capacitor, no Tauri)", () => {
    expect(() => createWebDavTransport()).toThrow(WebDavError)
  })

  it("routes through connectorsHttpRequest under Tauri", async () => {
    isTauriValue = true
    connectorsHttpRequestMock.mockResolvedValue({
      status: 207,
      headers: { "Content-Type": "application/xml" },
      body: "<ok/>",
    })
    const t = createWebDavTransport()
    const resp = await t.send({ method: "PROPFIND", url: "https://d/x", body: "q" })
    expect(connectorsHttpRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://d/x",
        method: "PROPFIND",
        body: "q",
        allowInvalidCertificates: false,
      })
    )
    expect(resp.status).toBe(207)
    // Headers are lowercased.
    expect(resp.headers["content-type"]).toBe("application/xml")
  })

  it("only accepts invalid certificates under Tauri after explicit opt-in", async () => {
    isTauriValue = true
    connectorsHttpRequestMock.mockResolvedValue({ status: 200, headers: {}, body: "" })

    const t = createWebDavTransport({ trustSelfSigned: true })
    await t.send({ method: "GET", url: "https://d/x" })

    expect(connectorsHttpRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({ allowInvalidCertificates: true })
    )
  })

  it("prefers CapacitorHttp when native, passes self-signed trust", async () => {
    capPlugin = {
      request: jest.fn().mockResolvedValue({ status: 200, headers: {}, data: "body", url: "u" }),
    }
    const t = createWebDavTransport({ trustSelfSigned: true })
    const resp = await t.send({ method: "GET", url: "https://d/x" })
    expect(capPlugin.request).toHaveBeenCalledWith(
      expect.objectContaining({ method: "GET", serverTrustMode: "self-signed", data: undefined })
    )
    expect(resp.body).toBe("body")
    // Capacitor wins even if Tauri is also reported.
    expect(connectorsHttpRequestMock).not.toHaveBeenCalled()
  })

  it("isWebDavSupported reflects platform availability", () => {
    expect(isWebDavSupported()).toBe(false) // web
    isTauriValue = true
    expect(isWebDavSupported()).toBe(true)
    isTauriValue = false
    capPlugin = { request: jest.fn() }
    expect(isWebDavSupported()).toBe(true)
  })

  it("stringifies non-string Capacitor response data", async () => {
    capPlugin = {
      request: jest.fn().mockResolvedValue({ status: 200, headers: {}, data: { a: 1 }, url: "u" }),
    }
    const t = createWebDavTransport()
    const resp = await t.send({ method: "GET", url: "https://d/x" })
    expect(resp.body).toBe('{"a":1}')
  })
})
