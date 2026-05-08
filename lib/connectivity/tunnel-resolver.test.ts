/**
 * @jest-environment jsdom
 */
import { getTunnelInfo, startTunnel, stopTunnel } from "./tunnel-resolver"

describe("startTunnel", () => {
  it("returns started with info on success", async () => {
    const invoke = jest.fn().mockResolvedValue({
      publicUrl: "https://abc.trycloudflare.com",
      localUrl: "https://127.0.0.1:7891",
    })
    const out = await startTunnel("https://127.0.0.1:7891", async () => ({ invoke }))
    expect(invoke).toHaveBeenCalledWith("companion_tunnel_start", {
      localUrl: "https://127.0.0.1:7891",
    })
    expect(out).toEqual({
      kind: "started",
      info: {
        publicUrl: "https://abc.trycloudflare.com",
        localUrl: "https://127.0.0.1:7891",
      },
    })
  })

  it("returns not_installed when cloudflared missing", async () => {
    const invoke = jest.fn().mockRejectedValue(new Error("cloudflared not found in PATH"))
    const out = await startTunnel("https://127.0.0.1:7891", async () => ({ invoke }))
    expect(out).toEqual({ kind: "not_installed" })
  })

  it("returns unsupported when not in Tauri", async () => {
    const out = await startTunnel("https://x", async () => null)
    expect(out).toEqual({ kind: "unsupported" })
  })

  it("returns error for other failures", async () => {
    const invoke = jest.fn().mockRejectedValue(new Error("permission denied"))
    const out = await startTunnel("https://x", async () => ({ invoke }))
    expect(out).toEqual({ kind: "error", message: "permission denied" })
  })
})

describe("stopTunnel", () => {
  it("calls companion_tunnel_stop", async () => {
    const invoke = jest.fn().mockResolvedValue(undefined)
    const out = await stopTunnel(async () => ({ invoke }))
    expect(invoke).toHaveBeenCalledWith("companion_tunnel_stop")
    expect(out).toEqual({ kind: "stopped" })
  })

  it("returns unsupported on web", async () => {
    expect(await stopTunnel(async () => null)).toEqual({ kind: "unsupported" })
  })
})

describe("getTunnelInfo", () => {
  it("returns the info from companion_tunnel_current", async () => {
    const invoke = jest.fn().mockResolvedValue({
      publicUrl: "https://abc.trycloudflare.com",
      localUrl: "https://127.0.0.1:7891",
    })
    const out = await getTunnelInfo(async () => ({ invoke }))
    expect(out).toEqual({
      publicUrl: "https://abc.trycloudflare.com",
      localUrl: "https://127.0.0.1:7891",
    })
  })

  it("returns null when not in Tauri", async () => {
    expect(await getTunnelInfo(async () => null)).toBeNull()
  })

  it("returns null when invoke throws", async () => {
    const invoke = jest.fn().mockRejectedValue(new Error("nope"))
    expect(await getTunnelInfo(async () => ({ invoke }))).toBeNull()
  })
})
