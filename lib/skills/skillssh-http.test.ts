jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(() => false),
}))
jest.mock("@/lib/claude/ipc", () => ({
  skillsFetchRemoteJson: jest.fn(),
}))
jest.mock("@/lib/connectivity/capacitor-http", () => ({
  getCapacitorHttp: jest.fn(() => null),
}))

import { isTauri } from "@/lib/tauri"
import { skillsFetchRemoteJson } from "@/lib/claude/ipc"
import { getCapacitorHttp } from "@/lib/connectivity/capacitor-http"
import {
  CorsUnavailableError,
  SkillsHttpError,
  isSkillsShWebBlocked,
  skillsHttpGet,
  skillsHttpGetJson,
} from "./skillssh-http"

const mockedIsTauri = isTauri as unknown as jest.Mock
const mockedRemoteJson = skillsFetchRemoteJson as unknown as jest.Mock
const mockedGetCap = getCapacitorHttp as unknown as jest.Mock

const realFetch = global.fetch

afterEach(() => {
  jest.clearAllMocks()
  mockedIsTauri.mockReturnValue(false)
  mockedGetCap.mockReturnValue(null)
  global.fetch = realFetch
})

describe("skillsHttpGet routing", () => {
  it("routes through the Tauri JSON proxy when isTauri", async () => {
    mockedIsTauri.mockReturnValue(true)
    mockedRemoteJson.mockResolvedValueOnce({ status: 200, body: '{"ok":true}', retryAfter: null })
    const result = await skillsHttpGet("https://skills.sh/api/search?q=x", {
      bearerToken: "tok",
      accept: "application/json",
    })
    expect(result).toEqual({ status: 200, text: '{"ok":true}', retryAfter: undefined })
    expect(mockedRemoteJson).toHaveBeenCalledWith({
      url: "https://skills.sh/api/search?q=x",
      bearerToken: "tok",
      accept: "application/json",
    })
  })

  it("surfaces retryAfter from the Tauri proxy", async () => {
    mockedIsTauri.mockReturnValue(true)
    mockedRemoteJson.mockResolvedValueOnce({ status: 429, body: "{}", retryAfter: "30" })
    const result = await skillsHttpGet("https://skills.sh/api/search?q=x")
    expect(result.status).toBe(429)
    expect(result.retryAfter).toBe("30")
  })

  it("routes through CapacitorHttp when native plugin is present", async () => {
    const request = jest.fn().mockResolvedValue({
      status: 200,
      data: '{"ok":1}',
      headers: { "Retry-After": "9" },
      url: "https://skills.sh/x",
    })
    mockedGetCap.mockReturnValue({ request })
    const result = await skillsHttpGet("https://skills.sh/x", { bearerToken: "tok" })
    expect(result).toEqual({ status: 200, text: '{"ok":1}', retryAfter: "9" })
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://skills.sh/x",
        method: "GET",
        headers: expect.objectContaining({ Authorization: "Bearer tok" }),
      })
    )
  })

  it("stringifies pre-parsed Capacitor JSON bodies", async () => {
    const request = jest.fn().mockResolvedValue({
      status: 200,
      data: { ok: 1 },
      headers: {},
      url: "https://skills.sh/x",
    })
    mockedGetCap.mockReturnValue({ request })
    const result = await skillsHttpGet("https://skills.sh/x")
    expect(result.text).toBe('{"ok":1}')
  })

  it("uses fetch on web and returns the response", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        new Response('{"ok":2}', { status: 200, headers: { "content-type": "application/json" } })
      ) as unknown as typeof fetch
    const result = await skillsHttpGet("https://skills.sh/x")
    expect(result.status).toBe(200)
    expect(result.text).toBe('{"ok":2}')
  })

  it("maps web fetch rejection to CorsUnavailableError", async () => {
    global.fetch = jest
      .fn()
      .mockRejectedValue(new TypeError("Failed to fetch")) as unknown as typeof fetch
    await expect(skillsHttpGet("https://skills.sh/x")).rejects.toBeInstanceOf(CorsUnavailableError)
  })
})

describe("skillsHttpGetJson", () => {
  it("parses 2xx JSON", async () => {
    mockedIsTauri.mockReturnValue(true)
    mockedRemoteJson.mockResolvedValueOnce({ status: 200, body: '{"a":1}', retryAfter: null })
    await expect(skillsHttpGetJson<{ a: number }>("https://skills.sh/x")).resolves.toEqual({
      a: 1,
    })
  })

  it("throws SkillsHttpError with status + retryAfter + server message on non-2xx", async () => {
    mockedIsTauri.mockReturnValue(true)
    mockedRemoteJson.mockResolvedValueOnce({
      status: 429,
      body: '{"error":"rate_limited","message":"slow down"}',
      retryAfter: "12",
    })
    const err = (await skillsHttpGetJson("https://skills.sh/x").catch(
      (e: unknown) => e
    )) as SkillsHttpError
    expect(err).toBeInstanceOf(SkillsHttpError)
    expect(err.status).toBe(429)
    expect(err.retryAfter).toBe("12")
    expect(err.message).toContain("slow down")
  })

  it("falls back to raw body slice when the error payload is not JSON", async () => {
    mockedIsTauri.mockReturnValue(true)
    mockedRemoteJson.mockResolvedValueOnce({ status: 503, body: "down", retryAfter: null })
    const err = (await skillsHttpGetJson("https://skills.sh/x").catch(
      (e: unknown) => e
    )) as SkillsHttpError
    expect(err).toBeInstanceOf(SkillsHttpError)
    expect(err.message).toContain("down")
  })
})

describe("isSkillsShWebBlocked", () => {
  it("is true on plain web", () => {
    expect(isSkillsShWebBlocked()).toBe(true)
  })

  it("is false on Tauri", () => {
    mockedIsTauri.mockReturnValue(true)
    expect(isSkillsShWebBlocked()).toBe(false)
  })

  it("is false when CapacitorHttp is available", () => {
    mockedGetCap.mockReturnValue({ request: jest.fn() })
    expect(isSkillsShWebBlocked()).toBe(false)
  })
})
