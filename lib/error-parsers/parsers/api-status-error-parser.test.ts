/**
 * @jest-environment node
 */

import { apiStatusErrorParser } from "./api-status-error-parser"

describe("apiStatusErrorParser", () => {
  it("maps a numbered status + reason to a statusCode node with a category", () => {
    const result = apiStatusErrorParser.parse("Request failed: 429 Too Many Requests")
    expect(result).not.toBeNull()
    expect(result!.nodes[0]).toMatchObject({
      kind: "statusCode",
      status: 429,
      category: "rateLimited",
    })
    expect(result!.nodes[1]).toMatchObject({ kind: "text" })
  })

  it("recognises an `HTTP <status>` prefix", () => {
    const result = apiStatusErrorParser.parse("HTTP/1.1 503 from upstream")
    expect(result!.nodes[0]).toMatchObject({
      kind: "statusCode",
      status: 503,
      category: "serviceUnavailable",
    })
  })

  it("recognises a `status code: N` prefix", () => {
    const result = apiStatusErrorParser.parse("server returned status code: 500")
    expect(result!.nodes[0]).toMatchObject({
      kind: "statusCode",
      status: 500,
      category: "serverError",
    })
  })

  it("keeps an unmapped 4xx/5xx as a bare statusCode node", () => {
    const result = apiStatusErrorParser.parse("error 451 unavailable for legal reasons")
    expect(result!.nodes[0]).toMatchObject({ kind: "statusCode", status: 451 })
    expect(result!.nodes[0].category).toBeUndefined()
  })

  it("classifies keyword-only provider signals", () => {
    expect(apiStatusErrorParser.parse("error: model_overloaded")!.nodes[0]).toMatchObject({
      kind: "category",
      category: "modelOverloaded",
    })
    expect(apiStatusErrorParser.parse("You exceeded your current quota")!.nodes[0]).toMatchObject({
      kind: "category",
      category: "quotaExceeded",
    })
    expect(apiStatusErrorParser.parse("invalid_request_error: bad model")!.nodes[0]).toMatchObject({
      kind: "category",
      category: "invalidRequest",
    })
    expect(
      apiStatusErrorParser.parse("AuthenticationError: invalid api key")!.nodes[0]
    ).toMatchObject({
      kind: "category",
      category: "unauthorized",
    })
    expect(apiStatusErrorParser.parse("error: rate limit reached")!.nodes[0]).toMatchObject({
      kind: "category",
      category: "rateLimited",
    })
    expect(apiStatusErrorParser.parse("permission denied for this model")!.nodes[0]).toMatchObject({
      kind: "category",
      category: "forbidden",
    })
  })

  it("does not match stray 3-digit numbers", () => {
    expect(apiStatusErrorParser.parse("connect ECONNREFUSED 127.0.0.1:3000")).toBeNull()
    expect(apiStatusErrorParser.parse("finished in 250 ms")).toBeNull()
    expect(apiStatusErrorParser.parse("exit code 130")).toBeNull()
  })
})
