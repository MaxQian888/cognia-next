import { getMessageMentions } from "./read"

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
