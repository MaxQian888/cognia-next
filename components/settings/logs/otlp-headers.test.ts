/**
 * The OTLP header field is a plaintext setting that ends up in localStorage
 * and in support bundles, so the parser's job is as much "refuse credentials"
 * as it is "read what the user pasted".
 */

import { parseHeaders, serializeHeaders } from "./otlp-headers"

describe("serializeHeaders", () => {
  it("renders a map as a single comma-separated line", () => {
    expect(serializeHeaders({ "X-Scope-OrgID": "42", "X-Env": "prod" })).toBe(
      "X-Scope-OrgID: 42, X-Env: prod"
    )
  })

  it("renders an empty map as an empty string", () => {
    expect(serializeHeaders({})).toBe("")
  })
})

describe("parseHeaders", () => {
  it("round-trips a serialized map", () => {
    const headers = { "X-Scope-OrgID": "42", "X-Env": "prod" }
    expect(parseHeaders(serializeHeaders(headers))).toEqual(headers)
  })

  it("returns an empty map for blank input", () => {
    expect(parseHeaders("")).toEqual({})
    expect(parseHeaders("   ")).toEqual({})
  })

  it("tolerates trailing commas and stray whitespace from a pasted example", () => {
    expect(parseHeaders("  X-Scope-OrgID :  42 ,  ")).toEqual({ "X-Scope-OrgID": "42" })
  })

  it("keeps a value containing a colon intact", () => {
    expect(parseHeaders("X-Target: host:4317")).toEqual({ "X-Target": "host:4317" })
  })

  it.each([
    "Authorization: Bearer secret",
    "authorization: Bearer secret",
    "Proxy-Authorization: Basic secret",
    "Cookie: session=abc",
    "Set-Cookie: session=abc",
    "X-API-Key: phc_secret",
  ])("drops the credential header %s", (line) => {
    expect(parseHeaders(line)).toEqual({})
  })

  it("keeps the safe headers of a mixed line and drops only the credential", () => {
    expect(parseHeaders("X-Env: prod, Authorization: Bearer secret, X-Scope-OrgID: 42")).toEqual({
      "X-Env": "prod",
      "X-Scope-OrgID": "42",
    })
  })

  it("skips fragments with no key", () => {
    expect(parseHeaders(": orphan, X-Env: prod")).toEqual({ "X-Env": "prod" })
  })
})
