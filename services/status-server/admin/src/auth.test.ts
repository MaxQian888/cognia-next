import { describe, expect, it, vi } from "vitest"

import { AuthError, accessAppUrl, resolveAccessToken } from "./auth"

const JWT = "eyJhbGciOiJSUzI1NiJ9.eyJlbWFpbCI6Im9wQGV4YW1wbGUuY29tIn0.c2ln"
const API = "https://status.cognia.cn/api/status/v1"

describe("resolveAccessToken", () => {
  it("prefers CF_ACCESS_TOKEN and validates its shape", async () => {
    const run = vi.fn()
    expect(
      await resolveAccessToken({ env: { CF_ACCESS_TOKEN: ` ${JWT} ` }, apiBase: API, run })
    ).toBe(JWT)
    expect(run).not.toHaveBeenCalled()
    await expect(
      resolveAccessToken({ env: { CF_ACCESS_TOKEN: "not-a-jwt" }, apiBase: API, run })
    ).rejects.toThrow(AuthError)
  })

  it("asks cloudflared for the API origin's token", async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: `${JWT}\n`, stderr: "" })
    expect(await resolveAccessToken({ env: {}, apiBase: API, run })).toBe(JWT)
    expect(run).toHaveBeenCalledWith("cloudflared", [
      "access",
      "token",
      "-app=https://status.cognia.cn",
    ])
  })

  it("explains how to log in when cloudflared is missing or not logged in", async () => {
    const missing = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("spawn cloudflared ENOENT"), { code: "ENOENT" }))
    await expect(resolveAccessToken({ env: {}, apiBase: API, run: missing })).rejects.toThrow(
      "cloudflared access login https://status.cognia.cn"
    )
    const loggedOut = vi
      .fn()
      .mockResolvedValue({ code: 1, stdout: "", stderr: "Unable to find token" })
    await expect(resolveAccessToken({ env: {}, apiBase: API, run: loggedOut })).rejects.toThrow(
      AuthError
    )
  })

  it("uses the origin as the Access application", () => {
    expect(accessAppUrl("https://status.example/api/status/v1")).toBe("https://status.example")
  })
})
