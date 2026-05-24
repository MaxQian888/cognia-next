/**
 * @jest-environment node
 */

import { anthropicErrorParser } from "./anthropic-error-parser"

describe("anthropicErrorParser", () => {
  it("maps a rate_limit_error envelope to a 429 statusCode + message + hint", () => {
    const text = JSON.stringify({
      type: "error",
      error: { type: "rate_limit_error", message: "Number of requests exceeded" },
    })
    const result = anthropicErrorParser.parse(text)
    expect(result).not.toBeNull()
    expect(result!.parsed).toBe(true)
    expect(result!.nodes[0]).toMatchObject({ kind: "statusCode", status: 429 })
    expect(result!.nodes[1].kind).toBe("text")
    expect(result!.nodes[1].content).toContain("Number of requests exceeded")
    expect(result!.nodes[1].content).toContain("rate limit")
  })

  it("maps authentication_error to 401", () => {
    const text = JSON.stringify({
      type: "error",
      error: { type: "authentication_error", message: "invalid x-api-key" },
    })
    const result = anthropicErrorParser.parse(text)
    expect(result!.nodes[0]).toMatchObject({ kind: "statusCode", status: 401 })
  })

  it("defaults unknown error types to 500", () => {
    const text = JSON.stringify({ type: "error", error: { type: "mystery_error", message: "x" } })
    expect(anthropicErrorParser.parse(text)!.nodes[0]).toMatchObject({ status: 500 })
  })

  it("returns null for non-error JSON and non-JSON text", () => {
    expect(anthropicErrorParser.parse('{"type":"message","content":[]}')).toBeNull()
    expect(anthropicErrorParser.parse("plain error text")).toBeNull()
    expect(anthropicErrorParser.parse('{"error": malformed')).toBeNull()
  })
})
