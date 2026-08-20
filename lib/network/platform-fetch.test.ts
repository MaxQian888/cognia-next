import {
  createPlatformFetch,
  platformFetchKind,
  reachesNonCorsHosts,
  PlatformFetchUnavailableError,
} from "./platform-fetch"

const detectPlatform = jest.fn<string, []>()
const getCapacitorHttp = jest.fn<unknown, []>()
const createProxyFetch = jest.fn()

jest.mock("@/lib/platform/detect", () => ({
  detectPlatform: () => detectPlatform(),
}))
jest.mock("@/lib/connectivity/capacitor-http", () => ({
  getCapacitorHttp: () => getCapacitorHttp(),
}))
jest.mock("@/lib/network/proxy-fetch", () => ({
  createProxyFetch: () => createProxyFetch(),
}))

beforeEach(() => {
  detectPlatform.mockReturnValue("web")
  getCapacitorHttp.mockReturnValue(null)
  createProxyFetch.mockReset()
})

describe("platformFetchKind", () => {
  it("routes the desktop shell through the native proxy bridge", () => {
    detectPlatform.mockReturnValue("tauri")
    expect(platformFetchKind()).toBe("tauri")
    expect(reachesNonCorsHosts()).toBe(true)
  })

  it("only claims the Capacitor path when the native plugin is actually present", () => {
    detectPlatform.mockReturnValue("mobile")
    // A mobile *web* build reports the platform without having the bridge.
    expect(platformFetchKind()).toBe("browser")
    getCapacitorHttp.mockReturnValue({ request: jest.fn() })
    expect(platformFetchKind()).toBe("capacitor")
  })

  it("admits that the browser is at the mercy of the target's CORS policy", () => {
    expect(platformFetchKind()).toBe("browser")
    expect(reachesNonCorsHosts()).toBe(false)
  })
})

describe("createPlatformFetch", () => {
  it("sends a JSON body through the Capacitor bridge as text", async () => {
    const request = jest.fn().mockResolvedValue({
      data: '{"ok":true}',
      status: 200,
      headers: { "content-type": "application/json" },
      url: "https://diag.test/v1/groups",
    })
    getCapacitorHttp.mockReturnValue({ request })
    const platformFetch = createPlatformFetch({ kind: "capacitor" })

    const response = await platformFetch("https://diag.test/v1/groups", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "resolved" }),
    })

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ method: "POST", data: '{"status":"resolved"}' })
    )
    await expect(response.json()).resolves.toEqual({ ok: true })
  })

  it("base64-encodes a binary body the native bridge could not otherwise carry", async () => {
    const request = jest.fn().mockResolvedValue({
      data: "{}",
      status: 201,
      headers: {},
      url: "https://diag.test/v1/incidents/x/parts/1",
    })
    getCapacitorHttp.mockReturnValue({ request })
    const platformFetch = createPlatformFetch({ kind: "capacitor" })

    await platformFetch("https://diag.test/v1/incidents/x/parts/1", {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: new Uint8Array([0, 1, 2, 253]),
    })

    // Without this the artifact would arrive as "[object ArrayBuffer]".
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ data: "AAEC/Q==" }))
  })

  it("never hands a body to a status that forbids one", async () => {
    const request = jest.fn().mockResolvedValue({
      data: "",
      status: 204,
      headers: {},
      url: "https://diag.test/v1/incidents/x",
    })
    getCapacitorHttp.mockReturnValue({ request })
    const platformFetch = createPlatformFetch({ kind: "capacitor" })

    // `new Response("", {status: 204})` throws; an empty string is still a body.
    const response = await platformFetch("https://diag.test/v1/incidents/x", { method: "DELETE" })
    expect(response.status).toBe(204)
    expect(response.body).toBeNull()
  })

  it("reports a missing native bridge as its own error type", async () => {
    getCapacitorHttp.mockReturnValue(null)
    const platformFetch = createPlatformFetch({ kind: "capacitor" })
    await expect(platformFetch("https://diag.test/v1/groups")).rejects.toBeInstanceOf(
      PlatformFetchUnavailableError
    )
  })

  it("builds the proxied fetch once rather than per request on desktop", async () => {
    const proxied = jest.fn().mockResolvedValue(new Response("{}", { status: 200 }))
    createProxyFetch.mockReturnValue(proxied)
    const platformFetch = createPlatformFetch({ kind: "tauri" })

    await platformFetch("https://diag.test/v1/groups")
    await platformFetch("https://diag.test/v1/incidents")

    expect(createProxyFetch).toHaveBeenCalledTimes(1)
    expect(proxied).toHaveBeenCalledTimes(2)
  })
})
