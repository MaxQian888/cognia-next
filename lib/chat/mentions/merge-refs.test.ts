import { mergeContextRefs } from "./merge-refs"
import type { ContextRef } from "./types"

const file: ContextRef = { kind: "file", id: "src/app.ts", raw: "@src/app.ts" }
const doc: ContextRef = { kind: "doc", id: "lark:d1", label: "Spec" }
const entity: ContextRef = { kind: "entity", id: "issue:i1", label: "Fix the race" }

describe("mergeContextRefs", () => {
  it("keeps parsed refs first, then the recorded citations", () => {
    expect(mergeContextRefs([file], [doc, entity])).toEqual([file, doc, entity])
  })

  it("returns the parsed list untouched when nothing was recorded", () => {
    expect(mergeContextRefs([file], [])).toEqual([file])
  })

  it("carries citations through when the message had no tokens at all", () => {
    // The whole point of the second list: a message that is pure prose can
    // still cite a staged record.
    expect(mergeContextRefs([], [entity])).toEqual([entity])
  })

  it("dedupes on kind+id, keeping the parsed occurrence", () => {
    const recordedCopy: ContextRef = { kind: "file", id: "src/app.ts", label: "recorded" }
    expect(mergeContextRefs([file], [recordedCopy])).toEqual([file])
  })

  it("does not collapse the same id across different kinds", () => {
    const sameIdOtherKind: ContextRef = { kind: "agent", id: "src/app.ts" }
    expect(mergeContextRefs([file], [sameIdOtherKind])).toHaveLength(2)
  })

  it("dedupes within the recorded list too", () => {
    expect(mergeContextRefs([], [entity, { ...entity, label: "again" }])).toEqual([entity])
  })
})
