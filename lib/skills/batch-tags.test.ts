import { unionTag, withoutTag, tagsAcrossSkills } from "./batch-tags"

describe("unionTag", () => {
  it("adds a trimmed tag without duplicating", () => {
    expect(unionTag(["a"], " b ")).toEqual(["a", "b"])
    expect(unionTag(["a"], "a")).toEqual(["a"])
  })
  it("handles an undefined list and blank input", () => {
    expect(unionTag(undefined, "x")).toEqual(["x"])
    expect(unionTag(["a"], "   ")).toEqual(["a"])
  })
})

describe("withoutTag", () => {
  it("removes the tag and tolerates an undefined list", () => {
    expect(withoutTag(["a", "b"], "a")).toEqual(["b"])
    expect(withoutTag(undefined, "a")).toEqual([])
  })
})

describe("tagsAcrossSkills", () => {
  it("returns the sorted union across skills", () => {
    expect(
      tagsAcrossSkills([{ tags: ["b", "a"] }, { tags: ["a", "c"] }, { tags: undefined }])
    ).toEqual(["a", "b", "c"])
  })
})
