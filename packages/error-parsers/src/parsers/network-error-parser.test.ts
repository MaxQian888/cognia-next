/**
 * @jest-environment node
 */

import { networkErrorParser } from "./network-error-parser"

describe("networkErrorParser", () => {
  const cases: ReadonlyArray<[string, string]> = [
    ["Error: connect ECONNREFUSED 127.0.0.1:3000", "connectionRefused"],
    ["read ECONNRESET", "connectionReset"],
    ["socket hang up", "connectionReset"],
    ["getaddrinfo ENOTFOUND api.anthropic.com", "dnsFailure"],
    ["Error: connect EHOSTUNREACH 10.0.0.1:443", "networkUnreachable"],
    ["write EPIPE", "brokenPipe"],
    ["connect ETIMEDOUT 1.2.3.4:443", "timeout"],
    ["the network request timed out after 30s", "timeout"],
    ["TypeError: Failed to fetch", "fetchFailed"],
    ["fetch failed", "fetchFailed"],
  ]

  it.each(cases)("classifies %p as %p", (text, category) => {
    const result = networkErrorParser.parse(text)
    expect(result).not.toBeNull()
    expect(result!.parsed).toBe(true)
    expect(result!.nodes[0]).toMatchObject({ kind: "category", category })
    // Original message preserved for downstream parsers.
    expect(result!.nodes[1]).toMatchObject({ kind: "text", content: text })
  })

  it("returns null for non-network errors", () => {
    expect(networkErrorParser.parse("ValueError: bad input")).toBeNull()
    expect(networkErrorParser.parse("the build timed out")).toBeNull()
  })
})
