import type { ContextSelectionRef } from "@/types/artifact/artifact"
import { citationsForSelections } from "./selection-citations"

const base = { snapshot: "body", comment: "", capturedAt: 1 }

describe("citationsForSelections", () => {
  it("cites each staged record in the shape the backlink index reads", () => {
    expect(
      citationsForSelections([
        { kind: "entity", entityKind: "issue", entityId: "i1", title: "Bug", ...base },
      ])
    ).toEqual([{ kind: "entity", id: "issue:i1", label: "Bug", raw: "@issue:i1" }])
  })

  // A multi-select shows one chip but references several messages, and each of
  // them earned its own backlink.
  it("cites every member of a combined reference", () => {
    const refs = citationsForSelections([
      {
        kind: "entity",
        entityKind: "message",
        entityId: "s#a",
        title: "2 messages",
        members: [
          { entityId: "s#a", title: "first" },
          { entityId: "s#b", title: "second" },
        ],
        ...base,
      },
    ])
    expect(refs.map((r) => r.id)).toEqual(["message:s#a", "message:s#b"])
    expect(refs.map((r) => r.label)).toEqual(["first", "second"])
  })

  it("cites nothing for kinds the backlink index cannot point back at", () => {
    const selections: ContextSelectionRef[] = [
      { kind: "file", relPath: "a.ts", title: "a.ts", snapshot: "x", comment: "" },
      { kind: "web", url: "https://x.dev", title: "X", snapshot: "x", comment: "" },
    ]
    expect(citationsForSelections(selections)).toEqual([])
  })

  it("cites a record once even when two references carry it", () => {
    const refs = citationsForSelections([
      { kind: "entity", entityKind: "message", entityId: "s#a", title: "a", ...base },
      {
        kind: "entity",
        entityKind: "message",
        entityId: "s#a",
        title: "2 messages",
        members: [
          { entityId: "s#a", title: "a" },
          { entityId: "s#b", title: "b" },
        ],
        ...base,
      },
    ])
    expect(refs.map((r) => r.id)).toEqual(["message:s#a", "message:s#b"])
  })
})
