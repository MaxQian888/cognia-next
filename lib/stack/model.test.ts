import {
  DEFAULT_BRANCH_TEMPLATE,
  baseBranches,
  renderBranchName,
  slugifyBranchSegment,
  stackTopology,
  type Stack,
} from "./model"

const STACK: Pick<Stack, "trunk" | "layers"> = {
  trunk: "main",
  layers: [
    { id: "c", branch: "me/c", title: "C", order: 2 },
    { id: "a", branch: "me/a", title: "A", order: 0 },
    { id: "b", branch: "me/b", title: "B", order: 1 },
  ],
}

describe("stackTopology", () => {
  it("makes each layer depend on the one below it", () => {
    expect(stackTopology(STACK)).toEqual([
      { id: "a", dependsOn: [], order: 0, tieBreaker: "me/a" },
      { id: "b", dependsOn: ["a"], order: 1, tieBreaker: "me/b" },
      { id: "c", dependsOn: ["b"], order: 2, tieBreaker: "me/c" },
    ])
  })
})

describe("baseBranches", () => {
  it("bases the bottom layer on the trunk and every other on the layer below", () => {
    // This map is what a pull request's base is set from, so getting it wrong
    // publishes a diff containing the layers underneath.
    expect([...baseBranches(STACK)]).toEqual([
      ["me/a", "main"],
      ["me/b", "me/a"],
      ["me/c", "me/b"],
    ])
  })

  it("handles a single-layer stack", () => {
    expect([...baseBranches({ trunk: "trunk", layers: [STACK.layers[1]!] })]).toEqual([
      ["me/a", "trunk"],
    ])
  })
})

describe("renderBranchName", () => {
  it("fills the default template", () => {
    expect(renderBranchName(DEFAULT_BRANCH_TEMPLATE, { user: "Ada", slug: "Fix the Thing" })).toBe(
      "ada/fix-the-thing"
    )
  })

  it("leaves an unknown placeholder visible rather than silently dropping it", () => {
    // A blanked segment produces a plausible name that collides with the next
    // one; a visibly wrong name gets fixed.
    expect(renderBranchName("{user}/{nope}", { user: "ada" })).toBe("ada/{nope}")
  })

  it("does not leave a leading or doubled slash when a value is absent", () => {
    // git rejects `/thing` outright, so an empty user must not produce one.
    expect(renderBranchName("{user}/{slug}", { user: "", slug: "thing" })).toBe("{user}/thing")
    expect(renderBranchName("a//{slug}", { slug: "b" })).toBe("a/b")
  })

  it("slugifies punctuation and trims to a sane length", () => {
    expect(slugifyBranchSegment("  Hello, World!! ")).toBe("hello-world")
    expect(slugifyBranchSegment("x".repeat(200))).toHaveLength(60)
    expect(slugifyBranchSegment("---")).toBe("")
  })
})
