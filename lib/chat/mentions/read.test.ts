import { getMessageMentions, isContextRef } from "./read"

describe("getMessageMentions", () => {
  it("returns stored structured refs verbatim", () => {
    const refs = getMessageMentions({
      metadata: {
        mentions: [
          { kind: "subagent", id: "code-reviewer", label: "Code Reviewer" },
          { kind: "file", id: "src/app.ts" },
        ],
      },
    })
    expect(refs).toHaveLength(2)
    expect(refs[0]).toMatchObject({ kind: "subagent", id: "code-reviewer" })
  })

  it("filters malformed rows out of stored metadata", () => {
    const refs = getMessageMentions({
      metadata: {
        mentions: [
          { kind: "file", id: "ok.ts" },
          { kind: "bogus-kind", id: "x" },
          { id: "missing-kind" },
          "not-an-object",
        ],
      },
    })
    expect(refs).toEqual([{ kind: "file", id: "ok.ts" }])
  })

  it("falls back to regex parsing for legacy messages (all-file kinds)", () => {
    const refs = getMessageMentions({ text: "look at @src/legacy.ts" })
    expect(refs).toEqual([{ kind: "file", id: "src/legacy.ts", raw: "@src/legacy.ts" }])
  })

  it("returns [] when neither metadata nor text is present", () => {
    expect(getMessageMentions({})).toEqual([])
    expect(getMessageMentions({ metadata: {} })).toEqual([])
  })
})

// Also the guard for citations restored from a draft row, which another build
// may have written.
describe("isContextRef", () => {
  it("accepts a ref of a known kind", () => {
    expect(isContextRef({ kind: "doc", id: "lark:doc_1", label: "Plan" })).toBe(true)
  })

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a string", "lark:doc_1"],
    ["a ref with no id", { kind: "doc" }],
    ["a ref of an unknown kind", { kind: "spreadsheet", id: "x" }],
  ])("rejects %s", (_label, value) => {
    expect(isContextRef(value)).toBe(false)
  })
})
