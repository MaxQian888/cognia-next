import { applyTemplate } from "./apply-template"

describe("applyTemplate", () => {
  it("substitutes $ARGUMENTS with the whole args string", () => {
    expect(applyTemplate("Review $ARGUMENTS please", "the auth module")).toBe(
      "Review the auth module please"
    )
  })

  it("substitutes positional $1..$9 from whitespace-split args", () => {
    expect(applyTemplate("$1 then $2", "alpha beta")).toBe("alpha then beta")
  })

  it("collapses unfilled positionals to empty", () => {
    expect(applyTemplate("[$1][$2]", "only")).toBe("[only][]")
  })

  it("leaves a template with no placeholders untouched", () => {
    expect(applyTemplate("static body", "ignored")).toBe("static body")
  })
})
