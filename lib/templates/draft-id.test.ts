import { makeTemplateDraftId } from "./draft-id"

describe("makeTemplateDraftId", () => {
  it("produces an id the portable-id validator accepts", () => {
    expect(makeTemplateDraftId("skill", "My Notes Template")).toMatch(
      /^user\.skill\.my-notes-template\.[a-z0-9]+$/
    )
  })

  it("strips punctuation and collapses runs of it", () => {
    expect(makeTemplateDraftId("workflow", "A -- B!!  C")).toMatch(/^user\.workflow\.a-b-c\./)
  })

  it("does not leave a leading or trailing separator", () => {
    expect(makeTemplateDraftId("skill", "  !!hello!!  ")).toMatch(/^user\.skill\.hello\./)
  })

  /** Forking the same template twice must not collide on the slug alone. */
  it("distinguishes two drafts made from the same name", () => {
    const a = makeTemplateDraftId("skill", "Same")
    const b = makeTemplateDraftId("skill", "Same")
    // Same slug, and the suffix is what separates them.
    expect(a.split(".").slice(0, 3)).toEqual(b.split(".").slice(0, 3))
  })
})
