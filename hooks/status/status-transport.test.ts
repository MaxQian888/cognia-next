jest.mock("@/lib/network/platform-fetch", () => ({ createPlatformFetch: jest.fn() }))

import { createPlatformFetch } from "@/lib/network/platform-fetch"
import { createStatusFixture } from "@/lib/status/fixtures"
import { parsePublicSnapshot } from "@/lib/status/public-status"

import {
  isAbortError,
  STATUS_GET_TIMEOUT_MS,
  statusGet,
  statusLiteralParser,
  statusPost,
  StatusRequestError,
} from "./status-transport"

const fetchMock = jest.fn()

function respond(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  }
}

beforeEach(() => {
  fetchMock.mockReset()
  ;(createPlatformFetch as jest.Mock).mockReturnValue(fetchMock)
})

afterEach(() => {
  jest.useRealTimers()
})

describe("statusGet", () => {
  it("returns a validated snapshot and sends an anonymous, revalidating GET", async () => {
    fetchMock.mockResolvedValue(respond(200, createStatusFixture("operational", "24h")))
    const { value, receivedAtMs } = await statusGet(
      "https://status.example/api/status/v1/snapshot?range=24h",
      parsePublicSnapshot
    )
    expect(value.range).toBe("24h")
    expect(typeof receivedAtMs).toBe("number")
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://status.example/api/status/v1/snapshot?range=24h")
    expect(init).toMatchObject({
      method: "GET",
      credentials: "omit",
      cache: "no-store",
      timeout: STATUS_GET_TIMEOUT_MS,
    })
    expect(init.body).toBeUndefined()
  })

  it("classifies an unsupported schema version separately from a malformed body", async () => {
    fetchMock.mockResolvedValueOnce(
      respond(200, { ...createStatusFixture("operational"), schemaVersion: 2 })
    )
    await expect(statusGet("u", parsePublicSnapshot)).rejects.toMatchObject({ kind: "unsupported" })

    fetchMock.mockResolvedValueOnce(respond(200, { schemaVersion: 1, mode: "preview" }))
    await expect(statusGet("u", parsePublicSnapshot)).rejects.toMatchObject({ kind: "invalid" })

    fetchMock.mockResolvedValueOnce(respond(200, "<html>not json</html>"))
    await expect(statusGet("u", parsePublicSnapshot)).rejects.toMatchObject({ kind: "invalid" })
  })

  it("surfaces the contract error code and request id of an HTTP failure", async () => {
    fetchMock.mockResolvedValue(respond(503, { code: "unavailable", requestId: "req-1" }))
    const error = await statusGet("u", parsePublicSnapshot).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(StatusRequestError)
    expect(error).toMatchObject({
      kind: "http",
      status: 503,
      code: "unavailable",
      requestId: "req-1",
    })
  })

  it("keeps an HTTP failure without a contract body as a bare status", async () => {
    fetchMock.mockResolvedValue(respond(502, "Bad gateway"))
    await expect(statusGet("u", parsePublicSnapshot)).rejects.toMatchObject({
      kind: "http",
      status: 502,
      code: null,
    })
  })

  it("reports a network failure", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"))
    await expect(statusGet("u", parsePublicSnapshot)).rejects.toMatchObject({ kind: "network" })
  })

  it("times out after 8 s as a visible timeout, not a silent abort", async () => {
    jest.useFakeTimers()
    fetchMock.mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
          )
        })
    )
    const pending = statusGet("u", parsePublicSnapshot)
    jest.advanceTimersByTime(STATUS_GET_TIMEOUT_MS)
    await expect(pending).rejects.toMatchObject({ kind: "timeout" })
  })

  it("rethrows a caller abort as an AbortError", async () => {
    const controller = new AbortController()
    fetchMock.mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new Error("aborted")))
        })
    )
    const pending = statusGet("u", parsePublicSnapshot, { signal: controller.signal })
    controller.abort()
    const error = await pending.catch((caught: unknown) => caught)
    expect(isAbortError(error)).toBe(true)
  })

  it("does not start a request for an already-aborted signal", async () => {
    const controller = new AbortController()
    controller.abort()
    const error = await statusGet("u", parsePublicSnapshot, { signal: controller.signal }).catch(
      (caught: unknown) => caught
    )
    expect(isAbortError(error)).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe("statusPost", () => {
  it("posts JSON without credentials and parses the literal answer", async () => {
    fetchMock.mockResolvedValue(respond(202, { status: "accepted" }))
    const { value } = await statusPost(
      "https://status.example/api/status/v1/subscriptions",
      { email: "a@example.com" },
      statusLiteralParser("accepted")
    )
    expect(value).toEqual({ status: "accepted" })
    const [, init] = fetchMock.mock.calls[0]
    expect(init).toMatchObject({ method: "POST", credentials: "omit", cache: "no-store" })
    expect(init.headers["content-type"]).toBe("application/json")
    expect(JSON.parse(init.body)).toEqual({ email: "a@example.com" })
  })

  it("rejects a body that is not the expected literal", async () => {
    fetchMock.mockResolvedValue(respond(200, { status: "subscribed" }))
    await expect(statusPost("u", {}, statusLiteralParser("accepted"))).rejects.toMatchObject({
      kind: "invalid",
    })
  })
})
