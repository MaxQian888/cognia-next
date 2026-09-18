import { getMessageMentions, isContextRef, pickReferenceMetadata } from "./read"

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

  it("accepts the member kind a team-room pick produces", () => {
    expect(isContextRef({ kind: "member", id: "member:u1", label: "Ada" })).toBe(true)
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

// The whitelist every transport boundary runs message metadata through —
// shared-session event payloads, host-state queue items, room RPC fields.
describe("pickReferenceMetadata", () => {
  it("returns undefined when there is no reference metadata", () => {
    for (const value of [undefined, null, "x", 3, {}, { unrelated: true }, []]) {
      expect(pickReferenceMetadata(value)).toBeUndefined()
    }
  })

  it("keeps valid mentions and the preamble summary, drops everything else", () => {
    const picked = pickReferenceMetadata({
      mentions: [
        { kind: "entity", id: "session:s1", label: "Sprint planning" },
        { kind: "bogus-kind", id: "x" },
        "not-an-object",
      ],
      promptPreamble: {
        sections: ["references"],
        references: [{ kind: "entity", entityKind: "session", title: "Sprint planning" }],
      },
      hostState: { secret: "does not cross" },
      usage: { tokens: 10 },
    })
    expect(picked).toEqual({
      mentions: [{ kind: "entity", id: "session:s1", label: "Sprint planning" }],
      promptPreamble: {
        sections: ["references"],
        references: [{ kind: "entity", entityKind: "session", title: "Sprint planning" }],
      },
    })
  })

  it("returns undefined when the mentions list is entirely malformed", () => {
    expect(pickReferenceMetadata({ mentions: [{ kind: "nope", id: "x" }] })).toBeUndefined()
    expect(pickReferenceMetadata({ mentions: "not-a-list" })).toBeUndefined()
  })

  it("survives a malformed preamble without losing the mentions", () => {
    expect(
      pickReferenceMetadata({
        mentions: [{ kind: "file", id: "src/a.ts" }],
        promptPreamble: "not-an-object",
      })
    ).toEqual({ mentions: [{ kind: "file", id: "src/a.ts" }] })
  })
})
