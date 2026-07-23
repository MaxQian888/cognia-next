import { readFileSync } from "node:fs"
import { join } from "node:path"

import {
  checkHeader,
  HEADER_POLICY_VERSION,
  isForwardableSemanticHeader,
  validateForwardedSemanticHeaders,
  validateStaticHeaders,
  type HeaderPolicyContext,
  type HeaderPolicyReason,
} from "./transport-header-policy"

interface FixtureCase {
  name: string
  value: string | null
  context: HeaderPolicyContext
  allowed: boolean
  reason: HeaderPolicyReason
}

interface SemanticCase {
  name: string
  semantic: boolean
}

const fixture = JSON.parse(
  readFileSync(join(__dirname, "..", "fixtures", "header-policy-cases.json"), "utf8")
) as { version: number; cases: FixtureCase[]; semanticForwardCases: SemanticCase[] }

describe("transport header policy — fixture parity", () => {
  it("matches the fixture version", () => {
    expect(fixture.version).toBe(HEADER_POLICY_VERSION)
  })

  it.each(fixture.cases.map((c) => [`${c.context}:${c.name || "<empty>"}:${c.reason}`, c]))(
    "verdict for %s",
    (_label, c) => {
      const verdict = checkHeader(c.name, c.value ?? undefined, c.context)
      expect(verdict.allowed).toBe(c.allowed)
      expect(verdict.reason).toBe(c.reason)
    }
  )

  it.each(fixture.semanticForwardCases.map((c) => [c.name, c] as const))(
    "semantic forwarding for %s",
    (_name, c) => {
      expect(isForwardableSemanticHeader(c.name)).toBe(c.semantic)
    }
  )
})

describe("validateStaticHeaders", () => {
  it("returns no violations for a clean map or absent input", () => {
    expect(validateStaticHeaders(undefined)).toEqual([])
    expect(
      validateStaticHeaders({ "anthropic-beta": "computer-use-2025-01-24", "x-tenant": "t1" })
    ).toEqual([])
  })

  it("collects every violation with its reason code", () => {
    const violations = validateStaticHeaders({
      authorization: "Bearer sk-live",
      host: "evil.example",
      "x-cognia-internal": "1",
      "x-good": "ok",
    })
    expect(violations).toEqual([
      { name: "authorization", reason: "auth-header" },
      { name: "host", reason: "host-header" },
      { name: "x-cognia-internal", reason: "internal-header" },
    ])
  })
})

describe("validateForwardedSemanticHeaders", () => {
  it("accepts vendor headers and rejects blocked names without needing values", () => {
    expect(validateForwardedSemanticHeaders(["anthropic-beta", "x-vendor-trace"])).toEqual([])
    expect(validateForwardedSemanticHeaders(["x-api-key", "connection"])).toEqual([
      { name: "x-api-key", reason: "auth-header" },
      { name: "connection", reason: "hop-by-hop" },
    ])
    expect(validateForwardedSemanticHeaders(undefined)).toEqual([])
  })
})
