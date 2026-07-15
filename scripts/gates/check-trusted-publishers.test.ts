import {
  checkTrustedPublisherSeeds,
  PLACEHOLDER_PREFIX,
  renderReport,
} from "./check-trusted-publishers"
import { TRUSTED_PUBLISHER_SEEDS } from "../../lib/db/seed/trusted-publishers"
import type { TrustedPublisherSeed } from "../../lib/db/seed/trusted-publishers"

function makeSeed(overrides: Partial<TrustedPublisherSeed> = {}): TrustedPublisherSeed {
  return {
    publicKey: "MCowBQYDK2VwAyEA-real-key",
    fingerprint: "9f3a1c8e4b7d2f605a1938e7c4b0d6f2938475610badc0ffee1234567890abcd",
    authorName: "Some Publisher",
    homepage: "https://example.org",
    firstTrustedAt: 0,
    lastSeenAt: 0,
    installCount: 0,
    provenance: "verified",
    ...overrides,
  }
}

describe("check-trusted-publishers gate", () => {
  it("the real seed list ships with no placeholder entries", () => {
    const report = checkTrustedPublisherSeeds()
    expect(report.violations).toEqual([])
    expect(report.ok).toBe(true)
  })

  it("the real seed list is empty — no row grants prompt-free execution", () => {
    // The v109 trust-model rebuild deleted all nine placeholder rows. If a row
    // is ever added back, it must come with a proof of possession; this
    // assertion is the tripwire that forces that conversation.
    expect(TRUSTED_PUBLISHER_SEEDS).toHaveLength(0)
  })

  it("fails a seed whose fingerprint is a placeholder", () => {
    const report = checkTrustedPublisherSeeds([
      makeSeed({ fingerprint: `${PLACEHOLDER_PREFIX}microsoft.vscode` }),
    ])
    expect(report.ok).toBe(false)
    expect(report.violations).toHaveLength(1)
    expect(report.violations[0]!.kind).toBe("placeholder-fingerprint")
    expect(report.violations[0]!.message).toMatch(/prompt-free binary execution/i)
  })

  it("fails a seed whose publicKey is a placeholder", () => {
    const report = checkTrustedPublisherSeeds([
      makeSeed({ publicKey: `${PLACEHOLDER_PREFIX}openvsx.root` }),
    ])
    expect(report.ok).toBe(false)
    expect(report.violations.map((v) => v.kind)).toContain("placeholder-public-key")
  })

  it("fails a seed that self-declares placeholder provenance", () => {
    const report = checkTrustedPublisherSeeds([makeSeed({ provenance: "placeholder" })])
    expect(report.ok).toBe(false)
    expect(report.violations.map((v) => v.kind)).toContain("placeholder-provenance")
  })

  it("reports every violation on a row, not just the first", () => {
    // The exact shape of the nine rows this gate exists to prevent.
    const report = checkTrustedPublisherSeeds([
      makeSeed({
        publicKey: `${PLACEHOLDER_PREFIX}microsoft.vscode`,
        fingerprint: `${PLACEHOLDER_PREFIX}microsoft.vscode`,
        provenance: "placeholder",
      }),
    ])
    expect(report.ok).toBe(false)
    expect(report.violations.map((v) => v.kind).sort()).toEqual([
      "placeholder-fingerprint",
      "placeholder-provenance",
      "placeholder-public-key",
    ])
  })

  it("passes a verified seed bound to a real key", () => {
    const report = checkTrustedPublisherSeeds([makeSeed()])
    expect(report.ok).toBe(true)
    expect(report.seedCount).toBe(1)
  })

  it("passes vacuously on an empty list", () => {
    const report = checkTrustedPublisherSeeds([])
    expect(report).toEqual({ ok: true, seedCount: 0, violations: [] })
  })

  describe("renderReport", () => {
    it("renders the OK line with the seed count", () => {
      expect(renderReport(checkTrustedPublisherSeeds([]))).toMatch(
        /OK \(0 seed row\(s\), 0 placeholders\)/
      )
    })

    it("renders each violation and explains the stakes", () => {
      const out = renderReport(
        checkTrustedPublisherSeeds([makeSeed({ fingerprint: `${PLACEHOLDER_PREFIX}x` })])
      )
      expect(out).toMatch(/FAILED \(1 violation\(s\)/)
      expect(out).toMatch(/✗ \[placeholder-fingerprint\]/)
      expect(out).toMatch(/prompt-free child_process\.spawn/)
    })
  })
})
