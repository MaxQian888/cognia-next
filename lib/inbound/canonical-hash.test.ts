/** @jest-environment jsdom */
import { canonicalizeText, computeCanonicalHash, stripUntrustedEnvelope } from "./canonical-hash"
import { wrapUntrusted } from "@/lib/external-bridge/untrusted"

describe("stripUntrustedEnvelope", () => {
  it("removes a well-formed envelope", () => {
    expect(stripUntrustedEnvelope(wrapUntrusted("hello")).trim()).toBe("hello")
  })

  it("leaves text without a complete envelope untouched", () => {
    expect(stripUntrustedEnvelope("plain")).toBe("plain")
    expect(stripUntrustedEnvelope("<untrusted_content>\nno close")).toBe(
      "<untrusted_content>\nno close"
    )
    expect(stripUntrustedEnvelope("no open\n</untrusted_content>")).toBe(
      "no open\n</untrusted_content>"
    )
  })
})

describe("canonicalizeText", () => {
  it("folds case and collapses whitespace runs", () => {
    expect(canonicalizeText("  Hello   \n\t WORLD  ")).toBe("hello world")
  })

  it("tolerates empty and nullish input", () => {
    expect(canonicalizeText("")).toBe("")
    expect(canonicalizeText(undefined as unknown as string)).toBe("")
  })
})

describe("computeCanonicalHash", () => {
  const base = { kind: "note" as const, title: "T", body: "B" }

  it("is stable for identical input", async () => {
    expect(await computeCanonicalHash(base)).toBe(await computeCanonicalHash(base))
  })

  it("ignores the differences a re-crawl actually produces", async () => {
    // Whitespace shifts and case changes are noise, not new content.
    const original = await computeCanonicalHash({
      kind: "note",
      title: "Rate limits",
      body: "Retry after 60s.",
    })
    const recrawled = await computeCanonicalHash({
      kind: "note",
      title: "  RATE   LIMITS ",
      body: "Retry\n\nafter    60s.",
    })
    expect(recrawled).toBe(original)
  })

  it("ignores whether the body arrived wrapped", async () => {
    // Producers hand this function raw or already-fenced bodies depending on
    // where they sit in the pipeline; the envelope is added by us, not them.
    expect(await computeCanonicalHash({ ...base, body: wrapUntrusted("B") })).toBe(
      await computeCanonicalHash(base)
    )
  })

  it("separates on kind, title, and body", async () => {
    const hash = await computeCanonicalHash(base)
    expect(await computeCanonicalHash({ ...base, kind: "lesson" })).not.toBe(hash)
    expect(await computeCanonicalHash({ ...base, title: "other" })).not.toBe(hash)
    expect(await computeCanonicalHash({ ...base, body: "other" })).not.toBe(hash)
  })

  it("does not let a field boundary be shifted to force a collision", async () => {
    expect(await computeCanonicalHash({ kind: "note", title: "ab", body: "c" })).not.toBe(
      await computeCanonicalHash({ kind: "note", title: "a", body: "bc" })
    )
  })

  it("returns a 64-character lowercase hex SHA-256", async () => {
    expect(await computeCanonicalHash(base)).toMatch(/^[0-9a-f]{64}$/)
  })
})
