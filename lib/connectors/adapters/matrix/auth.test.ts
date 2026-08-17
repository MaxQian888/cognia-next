import { invoke } from "@tauri-apps/api/core"
import {
  matrixLoginWithPassword,
  probeMatrixAccessToken,
  matrixWhoamiDetailed,
  normalizeHomeserver,
} from "./auth"

const mockInvoke = invoke as jest.Mock

function httpResp(status: number, body: unknown) {
  return { status, headers: {}, body: typeof body === "string" ? body : JSON.stringify(body) }
}

describe("normalizeHomeserver", () => {
  it("prepends https:// when no scheme is given", () => {
    expect(normalizeHomeserver("matrix.org")).toBe("https://matrix.org")
  })
  it("strips trailing slashes", () => {
    expect(normalizeHomeserver("https://matrix.org/")).toBe("https://matrix.org")
    expect(normalizeHomeserver("https://matrix.org///")).toBe("https://matrix.org")
  })
  it("keeps an existing http scheme", () => {
    expect(normalizeHomeserver("http://localhost:8008")).toBe("http://localhost:8008")
  })
  it("returns empty for blank input", () => {
    expect(normalizeHomeserver("   ")).toBe("")
  })
})

describe("matrixWhoamiDetailed", () => {
  beforeEach(() => mockInvoke.mockReset())

  it("returns user_id + device_id through the detailed helper", async () => {
    mockInvoke.mockResolvedValue(httpResp(200, { user_id: "@bot:matrix.org", device_id: "D" }))
    await expect(matrixWhoamiDetailed("matrix.org", "tok")).resolves.toEqual({
      userId: "@bot:matrix.org",
      deviceId: "D",
    })
  })

  it("returns null on non-2xx", async () => {
    mockInvoke.mockResolvedValue(httpResp(401, { errcode: "M_UNKNOWN_TOKEN" }))
    await expect(matrixWhoamiDetailed("matrix.org", "tok")).resolves.toBeNull()
  })

  it("returns null without homeserver or token", async () => {
    await expect(matrixWhoamiDetailed("", "tok")).resolves.toBeNull()
    await expect(matrixWhoamiDetailed("matrix.org", "")).resolves.toBeNull()
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it("returns null when the request throws", async () => {
    mockInvoke.mockRejectedValue(new Error("network"))
    await expect(matrixWhoamiDetailed("matrix.org", "tok")).resolves.toBeNull()
  })
})

describe("probeMatrixAccessToken", () => {
  beforeEach(() => mockInvoke.mockReset())

  it("returns the resolved Matrix identity on success", async () => {
    mockInvoke.mockResolvedValue(httpResp(200, { user_id: "@bot:matrix.org", device_id: "DEV" }))
    await expect(probeMatrixAccessToken("matrix.org", "syt_secret")).resolves.toEqual({
      ok: true,
      userId: "@bot:matrix.org",
      deviceId: "DEV",
    })
    expect(mockInvoke).toHaveBeenCalledWith("connectors_http_request", {
      req: expect.objectContaining({
        url: "https://matrix.org/_matrix/client/v3/account/whoami",
        headers: { Authorization: "Bearer syt_secret" },
      }),
    })
  })

  it("returns the Matrix error message when the token is rejected", async () => {
    mockInvoke.mockResolvedValue(
      httpResp(401, { errcode: "M_UNKNOWN_TOKEN", error: "Invalid access token" })
    )
    await expect(probeMatrixAccessToken("matrix.org", "bad")).resolves.toEqual({
      ok: false,
      error: "Matrix whoami failed: Invalid access token",
    })
  })

  it("returns a clear error for a non-JSON whoami response", async () => {
    mockInvoke.mockResolvedValue(httpResp(502, "<html>bad gateway</html>"))
    await expect(probeMatrixAccessToken("matrix.org", "tok")).resolves.toEqual({
      ok: false,
      error: "Matrix whoami returned non-JSON body (status 502)",
    })
  })

  it("returns request exceptions as probe errors", async () => {
    mockInvoke.mockRejectedValue(new Error("network offline"))
    await expect(probeMatrixAccessToken("matrix.org", "tok")).resolves.toEqual({
      ok: false,
      error: "network offline",
    })
  })
})

describe("matrixLoginWithPassword", () => {
  beforeEach(() => mockInvoke.mockReset())

  it("returns accessToken + userId on success", async () => {
    mockInvoke.mockResolvedValue(
      httpResp(200, { access_token: "syt_abc", user_id: "@bot:matrix.org", device_id: "DEV" })
    )
    await expect(matrixLoginWithPassword("matrix.org", "bot", "pw")).resolves.toEqual({
      accessToken: "syt_abc",
      userId: "@bot:matrix.org",
      deviceId: "DEV",
    })
  })

  it("throws the homeserver error message on failure", async () => {
    mockInvoke.mockResolvedValue(
      httpResp(403, { errcode: "M_FORBIDDEN", error: "Invalid password" })
    )
    await expect(matrixLoginWithPassword("matrix.org", "bot", "bad")).rejects.toThrow(
      "Invalid password"
    )
  })

  it("throws when the homeserver is missing", async () => {
    await expect(matrixLoginWithPassword("", "bot", "pw")).rejects.toThrow("Homeserver URL")
  })

  it("throws on a non-JSON body", async () => {
    mockInvoke.mockResolvedValue(httpResp(502, "<html>bad gateway</html>"))
    await expect(matrixLoginWithPassword("matrix.org", "bot", "pw")).rejects.toThrow("non-JSON")
  })
})
