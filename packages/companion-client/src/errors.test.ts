import {
  CompanionApiError,
  companionErrorCode,
  companionRetryAfterMs,
  expectCompanionJson,
} from "./errors"

function response(
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<Response> {
  return Promise.resolve(
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    })
  )
}

describe("expectCompanionJson", () => {
  it("answers the body of a success, and an empty object for none", async () => {
    await expect(expectCompanionJson(response(200, { a: 1 }))).resolves.toEqual({ a: 1 })
    await expect(
      expectCompanionJson(Promise.resolve(new Response(null, { status: 204 })))
    ).resolves.toEqual({})
  })

  it("turns a problem into an error carrying its code and the wait it asked for", async () => {
    const error = await expectCompanionJson(
      response(429, {
        type: "https://cognia.dev/problems/rate_limited",
        title: "Slow down",
        status: 429,
        detail: "too many requests",
        code: "rate_limited",
        details: { retryAfterSeconds: 7 },
      })
    ).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(CompanionApiError)
    expect(companionErrorCode(error)).toBe("rate_limited")
    expect(companionRetryAfterMs(error)).toBe(7_000)
    expect((error as CompanionApiError).status).toBe(429)
  })

  it("falls back to a Retry-After header, and to no wait at all", async () => {
    const headered = await expectCompanionJson(
      response(503, { oops: true }, { "retry-after": "3" })
    ).catch((caught: unknown) => caught)
    expect(companionRetryAfterMs(headered)).toBe(3_000)
    expect((headered as Error).message).toBe("HTTP 503")
    const plain = await expectCompanionJson(response(500, undefined)).catch(
      (caught: unknown) => caught
    )
    expect(companionRetryAfterMs(plain)).toBeNull()
    expect(companionRetryAfterMs(new Error("x"))).toBeNull()
  })
})
