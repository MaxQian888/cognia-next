/**
 * Coverage for the distill job runner's no-leak gate. `runDistillJob` itself is
 * exercised via the orchestrator suite; here we pin `sanitizeDraftPayload`,
 * which re-redacts PII the LLM may have hallucinated into a draft before it is
 * persisted. The shipped version only walked top-level string fields, so PII
 * nested in an array/object slipped through.
 */

import { sanitizeDraftPayload } from "./job-runner"

function draft(data: Record<string, unknown>) {
  return { payload: { kind: "knowledge", data } }
}

describe("sanitizeDraftPayload", () => {
  it("re-redacts PII nested inside arrays and objects (deep walk)", () => {
    const out = sanitizeDraftPayload(
      draft({
        title: "all good",
        items: ["reach alice@example.com", { note: "or carol@example.org", tags: ["x"] }],
      }),
      "job1",
      "twin1"
    )
    const serialized = JSON.stringify(out.payload.data)
    expect(serialized).not.toContain("alice@example.com")
    expect(serialized).not.toContain("carol@example.org")
    expect(serialized).toContain("<EMAIL_")
    // Untouched leaves are preserved.
    expect(out.payload.data.title).toBe("all good")
  })

  it("re-redacts a top-level string leak (parity with the previous behavior)", () => {
    const out = sanitizeDraftPayload(draft({ bio: "email bob@x.com" }), "j", "t")
    expect(out.payload.data.bio).not.toContain("bob@x.com")
    expect(out.payload.data.bio).toContain("<EMAIL_")
  })

  it("returns the same draft reference when there is no PII", () => {
    const d = draft({ title: "clean", items: ["nothing sensitive", { ok: true }] })
    expect(sanitizeDraftPayload(d, "j", "t")).toBe(d)
  })

  it("leaves non-string leaves (numbers, booleans, null) intact", () => {
    const out = sanitizeDraftPayload(
      draft({ count: 3, enabled: false, missing: null, nested: { n: 1 } }),
      "j",
      "t"
    )
    expect(out.payload.data).toEqual({ count: 3, enabled: false, missing: null, nested: { n: 1 } })
  })
})
