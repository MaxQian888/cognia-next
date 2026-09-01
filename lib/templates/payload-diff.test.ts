import { TEMPLATE_DIFF_ROOT, diffPayload, mergePayload } from "./payload-diff"

describe("diffPayload", () => {
  it("reports nothing when upstream did not move", () => {
    const base = { a: 1, b: 2 }
    expect(diffPayload(base, { a: 9, b: 2 }, { a: 1, b: 2 })).toEqual({
      changes: [],
      conflicts: [],
    })
  })

  it("reports nothing when both sides made the same edit", () => {
    expect(diffPayload({ a: 1 }, { a: 2 }, { a: 2 })).toEqual({ changes: [], conflicts: [] })
  })

  it("takes an upstream edit local never touched", () => {
    expect(diffPayload({ a: 1 }, { a: 1 }, { a: 2 })).toEqual({
      changes: [{ path: "$/a", before: 1, after: 2 }],
      conflicts: [],
    })
  })

  // The defect this module exists to fix: disjoint edits used to collapse into
  // one `$` conflict, which `planUpdate` turns into a hard blocker.
  it("separates disjoint edits instead of conflicting at the root", () => {
    const diff = diffPayload(
      { name: "base", timeout: 10 },
      { name: "mine", timeout: 10 },
      { name: "base", timeout: 30 }
    )
    expect(diff.conflicts).toEqual([])
    expect(diff.changes).toEqual([{ path: "$/timeout", before: 10, after: 30 }])
  })

  it("conflicts only on the field both sides moved", () => {
    const diff = diffPayload(
      { name: "base", timeout: 10 },
      { name: "mine", timeout: 10 },
      { name: "theirs", timeout: 30 }
    )
    expect(diff.changes).toEqual([{ path: "$/timeout", before: 10, after: 30 }])
    expect(diff.conflicts).toEqual([
      { path: "$/name", baseline: "base", local: "mine", next: "theirs" },
    ])
  })

  it("recurses into nested objects", () => {
    const diff = diffPayload(
      { config: { a: 1, b: 1 } },
      { config: { a: 2, b: 1 } },
      { config: { a: 1, b: 3 } }
    )
    expect(diff.conflicts).toEqual([])
    expect(diff.changes).toEqual([{ path: "$/config/b", before: 1, after: 3 }])
  })

  it("treats a changed array as one atomic unit", () => {
    const diff = diffPayload({ list: [1, 2] }, { list: [1, 2, 3] }, { list: [0, 1, 2] })
    expect(diff.changes).toEqual([])
    expect(diff.conflicts).toEqual([
      { path: "$/list", baseline: [1, 2], local: [1, 2, 3], next: [0, 1, 2] },
    ])
  })

  it("ignores key order", () => {
    expect(diffPayload({ a: 1, b: 2 }, { b: 2, a: 1 }, { a: 1, b: 2 })).toEqual({
      changes: [],
      conflicts: [],
    })
  })

  it("reports an added key with no `before`, and a removed key with no `after`", () => {
    expect(diffPayload({}, {}, { added: 1 }).changes).toEqual([{ path: "$/added", after: 1 }])
    expect(diffPayload({ gone: 1 }, { gone: 1 }, {}).changes).toEqual([
      { path: "$/gone", before: 1 },
    ])
  })

  it("escapes a slash in a key so the path stays unambiguous", () => {
    const diff = diffPayload({ "a/b": 1 }, { "a/b": 1 }, { "a/b": 2 })
    expect(diff.changes[0]?.path).toBe("$/a~1b")
  })

  it("conflicts at the root when the documents are not both objects", () => {
    const diff = diffPayload("base", "mine", "theirs")
    expect(diff.conflicts).toEqual([
      { path: TEMPLATE_DIFF_ROOT, baseline: "base", local: "mine", next: "theirs" },
    ])
  })
})

describe("mergePayload", () => {
  it("keeps the local edit and takes the disjoint upstream one", () => {
    expect(
      mergePayload(
        { name: "base", timeout: 10 },
        { name: "mine", timeout: 10 },
        { name: "base", timeout: 30 }
      )
    ).toEqual({ name: "mine", timeout: 30 })
  })

  it("keeps local on an unadopted conflict", () => {
    expect(mergePayload({ a: 1 }, { a: 2 }, { a: 3 })).toEqual({ a: 2 })
  })

  it("takes upstream on an adopted conflict", () => {
    expect(mergePayload({ a: 1 }, { a: 2 }, { a: 3 }, ["$/a"])).toEqual({ a: 3 })
  })

  it("applies non-conflicting changes even when nothing is adopted", () => {
    expect(mergePayload({ a: 1, b: 1 }, { a: 2, b: 1 }, { a: 1, b: 9 }, [])).toEqual({
      a: 2,
      b: 9,
    })
  })

  it("deletes a key upstream removed", () => {
    expect(mergePayload({ gone: 1, kept: 1 }, { gone: 1, kept: 1 }, { kept: 1 })).toEqual({
      kept: 1,
    })
  })

  it("creates the ancestor path for an adopted nested value", () => {
    expect(mergePayload({}, { other: 1 }, { config: { deep: 2 } })).toEqual({
      other: 1,
      config: { deep: 2 },
    })
  })

  it("does not mutate its inputs", () => {
    const local = { a: 1, b: 1 }
    mergePayload({ a: 1, b: 1 }, local, { a: 1, b: 2 })
    expect(local).toEqual({ a: 1, b: 1 })
  })

  it("adopts a whole array at its own path", () => {
    expect(mergePayload({ l: [1] }, { l: [2] }, { l: [3] }, ["$/l"])).toEqual({ l: [3] })
  })
})
