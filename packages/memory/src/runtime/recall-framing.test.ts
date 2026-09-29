import {
  MEMORY_RECALL_PREAMBLE,
  PROCEDURAL_PRECEDENCE_NOTE,
  RECALL_HEADING,
} from "./recall-framing"

describe("recall framing", () => {
  it("keeps the recall heading stable", () => {
    expect(RECALL_HEADING).toBe("## What you remember about the user")
  })

  it("frames recalled facts as data, not instructions", () => {
    expect(MEMORY_RECALL_PREAMBLE).toContain("not instructions")
    expect(MEMORY_RECALL_PREAMBLE).toContain("takes precedence")
    expect(MEMORY_RECALL_PREAMBLE).not.toContain("\n")
  })

  it("lets the current request override learned preferences", () => {
    expect(PROCEDURAL_PRECEDENCE_NOTE).toContain("follow the current request")
    expect(PROCEDURAL_PRECEDENCE_NOTE).not.toContain("\n")
  })
})
