import {
  acceptAllBlocks,
  changedBlockIds,
  diffDraftBlocks,
  joinDraftBlocks,
  mergeBlocks,
  PREAMBLE_ID,
  splitDraftIntoBlocks,
} from "./draft-merge"

const CURRENT = `## When to use
Use this for the monthly export.

## Steps
1. Open billing
2. Click Export

## Verify
The file downloads.`

const CANDIDATE = `## When to use
Use this for the monthly export.

## Steps
1. Open the billing portal
2. Choose Export

## Notes
Generated afresh.`

describe("splitDraftIntoBlocks", () => {
  it("splits on level-two headings", () => {
    expect(splitDraftIntoBlocks(CURRENT).map((b) => b.id)).toEqual([
      "When to use",
      "Steps",
      "Verify",
    ])
  })

  it("keeps anything before the first heading as a preamble", () => {
    const blocks = splitDraftIntoBlocks("intro text\n\n## Steps\n1. go")
    expect(blocks[0].id).toBe(PREAMBLE_ID)
    expect(blocks[0].body).toContain("intro text")
  })

  it("ignores a level-three heading", () => {
    expect(splitDraftIntoBlocks("## Steps\n### Detail\n1. go").map((b) => b.id)).toEqual(["Steps"])
  })

  it("round-trips through join", () => {
    expect(joinDraftBlocks(splitDraftIntoBlocks(CURRENT))).toBe(CURRENT.trim())
  })
})

describe("diffDraftBlocks", () => {
  it("classifies each section", () => {
    const diffs = diffDraftBlocks(CURRENT, CANDIDATE)
    const byId = Object.fromEntries(diffs.map((d) => [d.id, d.change]))
    expect(byId["When to use"]).toBe("unchanged")
    expect(byId.Steps).toBe("changed")
    expect(byId.Notes).toBe("added")
    expect(byId.Verify).toBe("removed")
  })

  it("keeps a section only the current draft has, so hand-written work stays visible", () => {
    const diffs = diffDraftBlocks(CURRENT, CANDIDATE)
    expect(diffs.map((d) => d.id)).toContain("Verify")
  })

  it("reports nothing changed for identical drafts", () => {
    expect(changedBlockIds(diffDraftBlocks(CURRENT, CURRENT))).toEqual([])
  })
})

describe("mergeBlocks", () => {
  it("keeps the current text for a section the user did not accept", () => {
    const merged = mergeBlocks(CURRENT, CANDIDATE, [])
    expect(merged).toContain("1. Open billing")
    expect(merged).not.toContain("Open the billing portal")
  })

  it("takes only the accepted section from the candidate", () => {
    const merged = mergeBlocks(CURRENT, CANDIDATE, ["Steps"])
    expect(merged).toContain("Open the billing portal")
    // The section the candidate omitted survives — silence is not a delete.
    expect(merged).toContain("## Verify")
  })

  it("adds a new section only when accepted", () => {
    expect(mergeBlocks(CURRENT, CANDIDATE, [])).not.toContain("## Notes")
    expect(mergeBlocks(CURRENT, CANDIDATE, ["Notes"])).toContain("Generated afresh")
  })

  it("drops a section when the user accepts its removal", () => {
    expect(mergeBlocks(CURRENT, CANDIDATE, ["Verify"])).not.toContain("## Verify")
  })

  it("never loses hand-written prose the candidate did not mention", () => {
    const edited = `${CURRENT}\n\n## My notes\nDo not lose this.`
    expect(mergeBlocks(edited, CANDIDATE, ["Steps"])).toContain("Do not lose this.")
  })
})

describe("acceptAllBlocks", () => {
  it("returns the candidate wholesale", () => {
    const accepted = acceptAllBlocks(CANDIDATE)
    expect(accepted).toContain("Open the billing portal")
    expect(accepted).toContain("## Notes")
    expect(accepted).not.toContain("## Verify")
  })
})
