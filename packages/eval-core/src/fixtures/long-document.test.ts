import { createLongDocumentFixture } from "./long-document"

describe("createLongDocumentFixture", () => {
  it("creates repeatable long Markdown with nested, code-only and prose facts", () => {
    const fixture = createLongDocumentFixture()
    expect(fixture).toEqual(createLongDocumentFixture())
    expect(fixture.originalText.length).toBeGreaterThan(70000)
    expect(fixture.originalText).toContain("### Recovery configuration\n\n")
    expect(fixture.originalText).toContain("```ini\nrecovery_delay_seconds = 47\n```")
    expect(fixture.cases[2].answer).toBeNull()
    expect(fixture.cases[2].evalCase.reference?.expectedContext).toEqual([])
  })

  it("retains headings and document identity across revised facts", () => {
    const before = createLongDocumentFixture({ backgroundSections: 2 })
    const after = createLongDocumentFixture({ revision: 2, backgroundSections: 2 })
    expect(after.id).toBe(before.id)
    expect(after.cases.map((entry) => entry.sectionTitle)).toEqual(
      before.cases.map((entry) => entry.sectionTitle)
    )
    expect(after.originalText).toContain("recovery_delay_seconds = 61")
    expect(after.originalText).not.toContain("recovery_delay_seconds = 47")
    expect(after.originalText).toContain("Birch operations")
  })

  it.each([0, -1, 1.5, NaN, Infinity, 501])(
    "rejects invalid background section count %s",
    (backgroundSections) => {
      expect(() => createLongDocumentFixture({ backgroundSections })).toThrow(RangeError)
    }
  )

  it("rejects an unsupported revision at the runtime boundary", () => {
    expect(() => createLongDocumentFixture({ revision: 3 as 1 })).toThrow(RangeError)
  })
})
