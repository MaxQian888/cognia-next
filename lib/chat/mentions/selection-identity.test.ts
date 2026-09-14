import type { ContextSelectionRef } from "@/types/artifact/artifact"
import { contextSelectionIdentity } from "./selection-identity"

const entity = (over: Partial<Extract<ContextSelectionRef, { kind: "entity" }>> = {}) =>
  ({
    kind: "entity",
    entityKind: "issue",
    entityId: "i1",
    title: "Bug",
    snapshot: "body",
    comment: "",
    capturedAt: 1,
    ...over,
  }) as ContextSelectionRef

describe("contextSelectionIdentity", () => {
  it("treats a re-staged record as the same reference whatever its snapshot", () => {
    expect(contextSelectionIdentity(entity())).toBe(
      contextSelectionIdentity(entity({ snapshot: "newer body", capturedAt: 9 }))
    )
  })

  it("separates records, kinds, and combined references", () => {
    const ids = new Set([
      contextSelectionIdentity(entity()),
      contextSelectionIdentity(entity({ entityId: "i2" })),
      contextSelectionIdentity(entity({ entityKind: "plan" })),
      contextSelectionIdentity(
        entity({
          entityKind: "message",
          entityId: "s#a",
          members: [
            { entityId: "s#a", title: "a" },
            { entityId: "s#b", title: "b" },
          ],
        })
      ),
      contextSelectionIdentity(entity({ entityKind: "message", entityId: "s#a" })),
    ])
    expect(ids.size).toBe(5)
  })

  it("keeps two ranges of one file, and two excerpts of one page, apart", () => {
    const file = (startLine: number) =>
      contextSelectionIdentity({
        kind: "file",
        relPath: "a.ts",
        title: "a.ts",
        snapshot: "x",
        comment: "",
        range: { startLine, endLine: startLine + 2 },
      })
    expect(file(1)).not.toBe(file(10))

    const web = (snapshot: string) =>
      contextSelectionIdentity({
        kind: "web",
        url: "https://x.dev",
        title: "X",
        snapshot,
        comment: "",
      })
    expect(web("first paragraph")).not.toBe(web("second paragraph"))
    expect(web("same")).toBe(web("same"))
  })

  it("keys an external capture by its native candidate id", () => {
    const external = (candidateId: string) =>
      contextSelectionIdentity({
        kind: "external",
        candidateId,
        sourceApp: "Safari",
        origin: "accessibility",
        truncated: false,
        title: "t",
        snapshot: "s",
        comment: "",
      })
    expect(external("c1")).toBe(external("c1"))
    expect(external("c1")).not.toBe(external("c2"))
  })
})
