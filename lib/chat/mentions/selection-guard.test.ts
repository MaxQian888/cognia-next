import { isContextSelectionRef } from "./selection-guard"

const base = {
  title: "Sprint planning",
  snapshot: "snapshot body",
  comment: "",
}

describe("isContextSelectionRef", () => {
  it("rejects non-objects and entries missing the shared fields", () => {
    for (const value of [null, undefined, 0, "chip", [], { kind: "entity" }, { ...base }]) {
      expect(isContextSelectionRef(value)).toBe(false)
    }
  })

  it("rejects an unknown kind outright", () => {
    expect(isContextSelectionRef({ ...base, kind: "hologram" })).toBe(false)
  })

  it("accepts an entity selection and keeps its extra fields", () => {
    const selection = {
      ...base,
      kind: "entity",
      entityKind: "session",
      entityId: "sess_1",
      capturedAt: 1720000000000,
      fingerprint: "v3",
      // A field a NEWER build could have written: passes through untouched.
      futureField: { anything: true },
    }
    expect(isContextSelectionRef(selection)).toBe(true)
  })

  it.each([
    ["memory"],
    ["issue"],
    ["plan"],
    ["session"],
    ["message"],
    ["prompt"],
    ["result"],
    ["artifact"],
    ["teammate"],
  ])("accepts entityKind %s", (entityKind) => {
    expect(
      isContextSelectionRef({
        ...base,
        kind: "entity",
        entityKind,
        entityId: "id_1",
        capturedAt: 1,
      })
    ).toBe(true)
  })

  it("rejects an entity whose entityKind is not a known noun", () => {
    expect(
      isContextSelectionRef({
        ...base,
        kind: "entity",
        entityKind: "quasar",
        entityId: "id_1",
        capturedAt: 1,
      })
    ).toBe(false)
  })

  it("rejects an entity missing entityId or capturedAt", () => {
    expect(
      isContextSelectionRef({ ...base, kind: "entity", entityKind: "session", capturedAt: 1 })
    ).toBe(false)
    expect(
      isContextSelectionRef({
        ...base,
        kind: "entity",
        entityKind: "session",
        entityId: "s",
        capturedAt: "now",
      })
    ).toBe(false)
  })

  it("checks each non-entity variant's discriminant fields", () => {
    expect(
      isContextSelectionRef({
        ...base,
        kind: "artifact",
        artifactId: "a1",
        range: { startLine: 1, endLine: 4 },
      })
    ).toBe(true)
    expect(isContextSelectionRef({ ...base, kind: "artifact", artifactId: "a1" })).toBe(false)

    expect(isContextSelectionRef({ ...base, kind: "file", relPath: "src/x.ts" })).toBe(true)
    expect(isContextSelectionRef({ ...base, kind: "file" })).toBe(false)

    expect(isContextSelectionRef({ ...base, kind: "comment" })).toBe(true)

    expect(isContextSelectionRef({ ...base, kind: "web", url: "https://x" })).toBe(true)
    expect(isContextSelectionRef({ ...base, kind: "web" })).toBe(false)

    expect(
      isContextSelectionRef({
        ...base,
        kind: "external",
        candidateId: "c1",
        sourceApp: "Notes",
        origin: "clipboard",
        truncated: false,
      })
    ).toBe(true)
    expect(
      isContextSelectionRef({
        ...base,
        kind: "external",
        candidateId: "c1",
        sourceApp: "Notes",
        origin: "mind-control",
        truncated: false,
      })
    ).toBe(false)

    expect(
      isContextSelectionRef({ ...base, kind: "plugin", pluginId: "p1", sourceLabel: "L" })
    ).toBe(true)
    expect(isContextSelectionRef({ ...base, kind: "plugin", pluginId: "p1" })).toBe(false)
  })
})
