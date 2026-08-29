import {
  __resetEntityMentionSourcesForTests,
  registerEntityMentionSource,
  unregisterEntityMentionSource,
} from "./entity-sources"
import { refreshSelectionFreshness } from "./selection-freshness"
import type { ContextSelectionRef, EntitySelectionKind } from "@/types/artifact/artifact"

const CUSTOM = "custom" as EntitySelectionKind

let fingerprint: jest.Mock

function entity(over: Partial<ContextSelectionRef> = {}): ContextSelectionRef {
  return {
    kind: "entity",
    entityKind: CUSTOM,
    entityId: "e1",
    title: "A record",
    snapshot: "body",
    comment: "",
    capturedAt: 1_000,
    fingerprint: "v1",
    ...over,
  } as ContextSelectionRef
}

const file: ContextSelectionRef = {
  kind: "file",
  relPath: "src/a.ts",
  title: "a.ts",
  snapshot: "x",
  comment: "",
}

beforeEach(() => {
  __resetEntityMentionSourcesForTests()
  fingerprint = jest.fn(async () => "v1")
  registerEntityMentionSource({
    entityKind: CUSTOM,
    prefix: "custom:",
    load: async () => [],
    snapshot: async () => "body",
    fingerprint: () => fingerprint(),
  })
})

afterEach(() => {
  unregisterEntityMentionSource(CUSTOM)
})

describe("refreshSelectionFreshness", () => {
  it("leaves an unchanged record alone, and returns the same array", async () => {
    const selections = [entity()]
    const pass = await refreshSelectionFreshness(selections)
    expect(pass.changed).toBe(false)
    // Reference equality, so a caller can use it as a render guard without
    // diffing — this runs on every window focus.
    expect(pass.selections).toBe(selections)
  })

  it("marks a record whose fingerprint moved", async () => {
    fingerprint.mockResolvedValue("v2")
    const pass = await refreshSelectionFreshness([entity()])
    expect(pass.changed).toBe(true)
    expect((pass.selections[0] as { stale?: boolean }).stale).toBe(true)
  })

  // Gone is a change like any other, and the strongest one.
  it("marks a record that no longer exists", async () => {
    fingerprint.mockResolvedValue(null)
    const pass = await refreshSelectionFreshness([entity()])
    expect((pass.selections[0] as { stale?: boolean }).stale).toBe(true)
  })

  // The user approved this body. Re-reading it at send time would mean they
  // approved one thing and sent another.
  it("never rewrites the snapshot", async () => {
    fingerprint.mockResolvedValue("v2")
    const pass = await refreshSelectionFreshness([entity({ snapshot: "the approved body" })])
    expect(pass.selections[0].snapshot).toBe("the approved body")
  })

  it("clears the flag once the record matches again", async () => {
    const pass = await refreshSelectionFreshness([entity({ stale: true } as never)])
    expect(pass.changed).toBe(true)
    expect("stale" in pass.selections[0]).toBe(false)
  })

  // Un-checkable is not the same as changed; reporting it as stale would train
  // people to ignore the badge.
  it("does not mark a selection staged before fingerprints existed", async () => {
    const pass = await refreshSelectionFreshness([entity({ fingerprint: undefined } as never)])
    expect(pass.changed).toBe(false)
    expect(fingerprint).not.toHaveBeenCalled()
  })

  it("does not mark a kind whose source declares no fingerprint", async () => {
    unregisterEntityMentionSource(CUSTOM)
    registerEntityMentionSource({
      entityKind: CUSTOM,
      prefix: "custom:",
      load: async () => [],
      snapshot: async () => "body",
    })
    const pass = await refreshSelectionFreshness([entity()])
    expect(pass.changed).toBe(false)
  })

  it("does not mark a kind whose source is gone", async () => {
    unregisterEntityMentionSource(CUSTOM)
    const pass = await refreshSelectionFreshness([entity()])
    expect(pass.changed).toBe(false)
  })

  // A file or web excerpt was captured from a surface with no version to ask.
  it("leaves non-entity selections untouched", async () => {
    const pass = await refreshSelectionFreshness([file])
    expect(pass.changed).toBe(false)
    expect(fingerprint).not.toHaveBeenCalled()
  })

  it("is empty-safe", async () => {
    expect(await refreshSelectionFreshness([])).toEqual({ selections: [], changed: false })
  })

  // A fingerprint read that throws must not lose the user's staged context.
  it("keeps a selection whose check failed", async () => {
    fingerprint.mockRejectedValue(new Error("db closed"))
    const selections = [entity()]
    const pass = await refreshSelectionFreshness(selections)
    expect(pass.changed).toBe(false)
    expect(pass.selections[0]).toBe(selections[0])
  })

  it("checks each selection independently", async () => {
    fingerprint.mockResolvedValueOnce("v1").mockResolvedValueOnce("moved")
    const pass = await refreshSelectionFreshness([
      entity({ entityId: "a" }),
      entity({ entityId: "b" }),
    ])
    expect((pass.selections[0] as { stale?: boolean }).stale).toBeUndefined()
    expect((pass.selections[1] as { stale?: boolean }).stale).toBe(true)
  })
})
