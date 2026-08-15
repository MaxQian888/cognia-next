let tauriValue = false
jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  isTauri: () => tauriValue,
}))
const connectorsHttpRequestMock = jest.fn()
jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsHttpRequest: (...a: unknown[]) => connectorsHttpRequestMock(...a),
}))

import { backupHttpRequest, parseJsonBody, resolveBackupHttp, toBase64Utf8 } from "./http"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  tauriValue = false
  connectorsHttpRequestMock.mockReset()
})

describe("backup http", () => {
  it("uses fetch off-desktop and lower-cases response headers", async () => {
    globalThis.fetch = jest.fn(async () => ({
      status: 201,
      headers: new Map([["Content-Type", "application/json"]]),
      text: async () => '{"ok":true}',
    })) as unknown as typeof fetch
    const response = await backupHttpRequest({
      url: "https://x/y",
      method: "POST",
      headers: { A: "b" },
      body: "{}",
    })
    expect(response).toEqual({
      status: 201,
      headers: { "content-type": "application/json" },
      body: '{"ok":true}',
    })
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://x/y",
      expect.objectContaining({ method: "POST", headers: { A: "b" }, body: "{}" })
    )
  })

  it("routes through connectors_http_request on the desktop", async () => {
    tauriValue = true
    connectorsHttpRequestMock.mockResolvedValue({
      status: 200,
      headers: { "X-Rate": "1" },
      body: "hi",
    })
    const response = await resolveBackupHttp()({ url: "https://x", method: "GET" })
    expect(connectorsHttpRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://x", method: "GET", timeoutMs: 60_000 })
    )
    expect(response).toEqual({ status: 200, headers: { "x-rate": "1" }, body: "hi" })
    connectorsHttpRequestMock.mockResolvedValue({ status: 204 })
    expect(await resolveBackupHttp()({ url: "https://x", method: "DELETE" })).toEqual({
      status: 204,
      headers: {},
      body: "",
    })
  })

  it("parses JSON defensively and base64-encodes UTF-8", () => {
    expect(parseJsonBody("")).toBeNull()
    expect(parseJsonBody("{nope")).toBeNull()
    expect(parseJsonBody<{ a: number }>('{"a":1}')).toEqual({ a: 1 })
    expect(toBase64Utf8("héllo")).toBe(Buffer.from("héllo", "utf8").toString("base64"))
  })
})
