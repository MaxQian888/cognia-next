/**
 * @jest-environment node
 */

import { httpPreset } from "./http-preset"

describe("httpPreset", () => {
  it("extracts HTTP status code and URL", () => {
    const text = "HTTP 404 Not Found\nhttps://api.example.com/users"
    const result = httpPreset.parse(text)
    expect(result.parsed).toBe(true)
    expect(result.nodes[0].kind).toBe("statusCode")
    expect(result.nodes[0].status).toBe(404)
    expect(result.nodes.some((n) => n.kind === "url")).toBe(true)
  })

  it("extracts status from alternative wording", () => {
    const text = "Request failed with status: 500"
    const result = httpPreset.parse(text)
    expect(result.nodes[0].kind).toBe("statusCode")
    expect(result.nodes[0].status).toBe(500)
  })

  it("parses JSON response body", () => {
    const text = 'HTTP 400\nhttps://api.example.com\n{"error": "bad request"}'
    const result = httpPreset.parse(text)
    expect(result.nodes.some((n) => n.kind === "json")).toBe(true)
  })

  it("handles 2xx status", () => {
    const text = "HTTP 200 OK"
    const result = httpPreset.parse(text)
    expect(result.nodes[0].status).toBe(200)
  })

  it("falls back to text when no matches", () => {
    const text = "some random error"
    const result = httpPreset.parse(text)
    expect(result.parsed).toBe(false)
    expect(result.nodes[0].kind).toBe("text")
  })
})
