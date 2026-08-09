/**
 * Coverage for the app-side TTS host bindings (ADR-0068 E3): the module
 * installs the Tauri bridges into `@cognia/tts/host` on import, and
 * `tauriProxyFetch` packages requests for the `tts_proxy_fetch` Rust command
 * exactly as the pre-extraction proxyFetch did.
 */

jest.mock("@/lib/tauri", () => ({ isCapacitor: jest.fn(), isTauri: jest.fn() }))
jest.mock("sonner", () => ({ toast: { error: jest.fn(), message: jest.fn() } }))

import { toast } from "sonner"
import * as core from "@tauri-apps/api/core"

import { getTtsHost } from "@cognia/tts/host"
import { isCapacitor, isTauri } from "@/lib/tauri"

import { tauriProxyFetch } from "./host-bindings"

const mockIsTauri = isTauri as jest.Mock
const mockInvoke = core.invoke as unknown as jest.Mock

beforeEach(() => {
  mockIsTauri.mockReset()
  mockInvoke.mockReset()
})

describe("host installation (module side effect)", () => {
  it("installs nativeProxyFetch, shell gates, outbound PII gate, and notify", () => {
    const host = getTtsHost()
    expect(typeof host.nativeProxyFetch).toBe("function")
    expect(host.isNativeShell).toBe(isTauri)
    expect(host.isMobileShell).toBe(isCapacitor)
    expect(host.allowCloudText?.("clean text", "openai")).toBe(true)
    expect(host.allowCloudText?.("email alice@example.com", "openai")).toBe(false)
    expect(typeof host.notify?.message).toBe("function")
    expect(typeof host.notify?.error).toBe("function")
  })

  it("nativeProxyFetch returns null on web (isTauri false) so the package falls through", () => {
    mockIsTauri.mockReturnValue(false)
    expect(getTtsHost().nativeProxyFetch?.("https://x", {})).toBeNull()
  })

  it("nativeProxyFetch routes through tauriProxyFetch when isTauri", async () => {
    mockIsTauri.mockReturnValue(true)
    mockInvoke.mockResolvedValueOnce({ status: 200, mime: "x", body_b64: "" })
    await getTtsHost().nativeProxyFetch?.("https://api.example.com/x", { json: {} })
    expect(mockInvoke).toHaveBeenCalledWith("tts_proxy_fetch", expect.anything())
  })

  it("notify bridges to sonner toasts", () => {
    getTtsHost().notify?.message("m")
    getTtsHost().notify?.error("e")
    expect(toast.message).toHaveBeenCalledWith("m")
    expect(toast.error).toHaveBeenCalledWith("e")
  })
})

describe("tauriProxyFetch", () => {
  it("packages JSON body and forwards default method", async () => {
    mockInvoke.mockResolvedValueOnce({
      status: 201,
      mime: "audio/mpeg",
      body_b64: btoa("hi"),
    })
    const r = await tauriProxyFetch("https://api.example.com/x", {
      json: { foo: 1 },
      headers: { "x-h": "v" },
    })
    expect(mockInvoke).toHaveBeenCalledWith(
      "tts_proxy_fetch",
      expect.objectContaining({
        request: expect.objectContaining({
          url: "https://api.example.com/x",
          method: "POST",
          headers: { "x-h": "v" },
          json: { foo: 1 },
        }),
      })
    )
    expect(r.status).toBe(201)
    expect(r.ok).toBe(true)
    expect(r.mime).toBe("audio/mpeg")
    expect(await r.text()).toBe("hi")
  })

  it("encodes Uint8Array body as base64", async () => {
    mockInvoke.mockResolvedValueOnce({ status: 200, mime: "x", body_b64: "" })
    await tauriProxyFetch("https://api.example.com/x", {
      method: "PUT",
      body: new Uint8Array([0x68, 0x69]),
    })
    const req = (mockInvoke.mock.calls[0][1] as { request: { body_b64?: string } }).request
    expect(req.body_b64).toBe(btoa("hi"))
  })

  it("encodes ArrayBuffer body as base64", async () => {
    mockInvoke.mockResolvedValueOnce({ status: 200, mime: "x", body_b64: "" })
    const buf = new TextEncoder().encode("hi").buffer as ArrayBuffer
    await tauriProxyFetch("https://api.example.com/x", { body: buf })
    const req = (mockInvoke.mock.calls[0][1] as { request: { body_b64?: string } }).request
    expect(req.body_b64).toBe(btoa("hi"))
  })

  it("encodes Blob body as base64", async () => {
    mockInvoke.mockResolvedValueOnce({ status: 200, mime: "x", body_b64: "" })
    // jsdom's Blob doesn't ship .arrayBuffer(); polyfill from FileReader.
    if (typeof Blob.prototype.arrayBuffer !== "function") {
      Blob.prototype.arrayBuffer = function () {
        return new Promise((resolve) => {
          const r = new FileReader()
          r.onload = () => resolve(r.result as ArrayBuffer)
          r.readAsArrayBuffer(this)
        })
      }
    }
    const blob = new Blob(["hi"])
    await tauriProxyFetch("https://api.example.com/x", { body: blob })
    const req = (mockInvoke.mock.calls[0][1] as { request: { body_b64?: string } }).request
    expect(req.body_b64).toBe(btoa("hi"))
  })

  it("classifies status>=400 as not ok", async () => {
    mockInvoke.mockResolvedValueOnce({
      status: 401,
      mime: "application/json",
      body_b64: btoa('{"error":"nope"}'),
    })
    const r = await tauriProxyFetch("https://api.example.com/x", { json: {} })
    expect(r.ok).toBe(false)
    expect(await r.json<{ error: string }>()).toEqual({ error: "nope" })
  })

  it("base64-encoding handles large bodies in chunks", async () => {
    mockInvoke.mockResolvedValueOnce({ status: 200, mime: "x", body_b64: "" })
    // Larger than the 0x8000 chunk threshold to exercise the loop.
    const big = new Uint8Array(0x8001)
    big.fill(0x41)
    await tauriProxyFetch("https://api.example.com/x", { body: big })
    const req = (mockInvoke.mock.calls[0][1] as { request: { body_b64?: string } }).request
    expect(typeof req.body_b64).toBe("string")
    expect((req.body_b64 ?? "").length).toBeGreaterThan(0)
  })

  it("returns an empty ArrayBuffer when body_b64 is empty", async () => {
    mockInvoke.mockResolvedValueOnce({ status: 200, mime: "x", body_b64: "" })
    const r = await tauriProxyFetch("https://api.example.com/x", { json: {} })
    expect(r.bytes.byteLength).toBe(0)
  })

  it("defaults headers to {} when not provided", async () => {
    mockInvoke.mockResolvedValueOnce({ status: 200, mime: "x", body_b64: "" })
    await tauriProxyFetch("https://api.example.com/x", { json: { a: 1 } })
    const req = (mockInvoke.mock.calls[0][1] as { request: { headers: Record<string, string> } })
      .request
    expect(req.headers).toEqual({})
  })

  it("forwards provider identity and cancels an aborted native request", async () => {
    const controller = new AbortController()
    mockInvoke.mockImplementation((command: string) => {
      if (command === "tts_proxy_cancel") return Promise.resolve(true)
      return new Promise((_, reject) => {
        controller.signal.addEventListener("abort", () => reject(new Error("request cancelled")))
      })
    })

    const pending = tauriProxyFetch("http://localhost:8880/v1/audio/speech", {
      provider: "local-openai-compatible",
      requestId: "req-local",
      timeoutMs: 2500,
      signal: controller.signal,
      json: {},
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
    expect(mockInvoke).toHaveBeenCalledWith("tts_proxy_cancel", { requestId: "req-local" })
    expect(mockInvoke).toHaveBeenCalledWith(
      "tts_proxy_fetch",
      expect.objectContaining({
        request: expect.objectContaining({
          provider: "local-openai-compatible",
          request_id: "req-local",
          timeout_ms: 2500,
        }),
      })
    )
  })
})
