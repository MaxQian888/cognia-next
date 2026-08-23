/** @jest-environment node */
import { webcrypto } from "node:crypto"

import {
  canonicalMcpOAuthEndpoint,
  normalizeMcpOAuthScopes,
  resolveMcpOAuthCredentialPartition,
  reviewMcpOAuthScopes,
  runMcpOAuthRefreshSingleFlight,
} from "./oauth-security"

beforeAll(() => {
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto })
})

const remote = (url: string, scope?: string) => ({
  transport: "http" as const,
  config: { url, scope },
})

describe("MCP OAuth credential security", () => {
  it("canonicalizes remote endpoints while retaining origin-routing queries", () => {
    expect(canonicalMcpOAuthEndpoint(remote("https://EXAMPLE.com//mcp/?tenant=secret#x"))).toBe(
      "https://example.com/mcp?tenant=secret"
    )
    expect(() => canonicalMcpOAuthEndpoint(remote("http://example.com/mcp"))).toThrow(/HTTPS/)
    expect(() => canonicalMcpOAuthEndpoint(remote("https://user:secret@example.com/mcp"))).toThrow(
      /credentials/
    )
  })

  it("isolates credentials by endpoint and normalized scope partition", async () => {
    const first = await resolveMcpOAuthCredentialPartition(
      "figma",
      remote("https://mcp.example.com/mcp", "write read read")
    )
    const same = await resolveMcpOAuthCredentialPartition(
      "figma",
      remote("https://mcp.example.com/mcp/", "read write")
    )
    const broader = await resolveMcpOAuthCredentialPartition(
      "figma",
      remote("https://mcp.example.com/mcp", "admin read write")
    )
    expect(normalizeMcpOAuthScopes(remote("https://x", "write read read"))).toEqual([
      "read",
      "write",
    ])
    expect(first.credentialKey).toBe(same.credentialKey)
    expect(broader.credentialKey).not.toBe(first.credentialKey)
    expect(broader.endpointFingerprint).toBe(first.endpointFingerprint)
    const otherTenant = await resolveMcpOAuthCredentialPartition(
      "figma",
      remote("https://mcp.example.com/mcp?tenant=other", "read write")
    )
    expect(otherTenant.endpointFingerprint).not.toBe(first.endpointFingerprint)
  })

  it("identifies scope expansion as explicit step-up", () => {
    expect(reviewMcpOAuthScopes(["read"], ["read", "write"])).toEqual({
      state: "step-up",
      requested: ["read", "write"],
      added: ["write"],
      removed: [],
    })
    expect(reviewMcpOAuthScopes(["read", "write"], ["read"]).state).toBe("reduced")
  })

  it("uses one refresh for concurrent callers and releases the flight afterward", async () => {
    let calls = 0
    let release!: (value: string) => void
    const refresh = jest.fn(
      () =>
        new Promise<string>((resolve) => {
          calls += 1
          release = resolve
        })
    )
    const one = runMcpOAuthRefreshSingleFlight("partition", refresh)
    const two = runMcpOAuthRefreshSingleFlight("partition", refresh)
    expect(calls).toBe(1)
    release("token")
    await expect(Promise.all([one, two])).resolves.toEqual(["token", "token"])
    await runMcpOAuthRefreshSingleFlight("partition", async () => "next")
    expect(refresh).toHaveBeenCalledTimes(1)
  })
})
