// Per-source scan state: CRUD plus the freshness fold the ambient surfaces
// read. The fold is the part that matters, because it is what stops a source
// we could not read from rendering as a source with no spend.

import { createDbTestFixture } from "./test-fixture"
import {
  deleteUsageSourceState,
  emptyUsageSourceState,
  foldSourceFreshness,
  getUsageSourceState,
  listUsageSourceStates,
  putUsageSourceState,
  updateUsageSourceState,
  USAGE_SCAN_PARSER_VERSION,
  type UsageSourceStateRow,
} from "./usage-source-states"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

const state = (over: Partial<UsageSourceStateRow> = {}): UsageSourceStateRow => ({
  ...emptyUsageSourceState(over.sourceId ?? "codex"),
  ...over,
})

describe("emptyUsageSourceState", () => {
  it("starts unknown at the current parser version", () => {
    const s = emptyUsageSourceState("codex")
    expect(s.status).toBe("unknown")
    expect(s.parserVersion).toBe(USAGE_SCAN_PARSER_VERSION)
    expect(s.lastSuccessAt).toBeNull()
  })
})

describe("CRUD", () => {
  it("round-trips a row", async () => {
    await putUsageSourceState(state({ status: "fresh", rowCount: 12 }))
    const back = await getUsageSourceState("codex")
    expect(back?.rowCount).toBe(12)
  })

  it("ignores a write with no source id", async () => {
    await putUsageSourceState(state({ sourceId: "" }))
    expect(await listUsageSourceStates()).toHaveLength(0)
  })

  it("returns null for an unknown source rather than inventing a row", async () => {
    expect(await getUsageSourceState("nope")).toBeNull()
    expect(await getUsageSourceState("")).toBeNull()
  })

  it("merges a patch onto an absent row by creating it", async () => {
    const committed = await updateUsageSourceState("cursor", { status: "partial" })
    expect(committed?.status).toBe("partial")
    expect(committed?.parsedCount).toBe(0)
  })

  it("merges a patch onto an existing row without dropping other fields", async () => {
    await putUsageSourceState(state({ status: "fresh", rowCount: 7, parsedCount: 3 }))
    const committed = await updateUsageSourceState("codex", { status: "partial" })
    expect(committed).toMatchObject({ status: "partial", rowCount: 7, parsedCount: 3 })
  })

  it("deletes a source's state", async () => {
    await putUsageSourceState(state())
    await deleteUsageSourceState("codex")
    expect(await getUsageSourceState("codex")).toBeNull()
  })
})

describe("foldSourceFreshness", () => {
  it("is stale with nothing scanned", () => {
    expect(foldSourceFreshness([])).toBe("stale")
    expect(foldSourceFreshness([state({ status: "unknown" })])).toBe("stale")
  })

  it("is fresh only when every scannable source read everything", () => {
    expect(foldSourceFreshness([state({ status: "fresh" })])).toBe("fresh")
  })

  it("degrades to partial when one source could not be read", () => {
    expect(
      foldSourceFreshness([
        state({ sourceId: "codex", status: "fresh" }),
        state({ sourceId: "cursor", status: "unavailable" }),
      ])
    ).toBe("partial")
  })

  it("does not let a picker-only source hold the fold back", () => {
    expect(
      foldSourceFreshness([
        state({ sourceId: "codex", status: "fresh" }),
        state({ sourceId: "aider", status: "picker-only" }),
      ])
    ).toBe("fresh")
  })

  it("is stale when every source is picker-only, because nothing was scanned", () => {
    expect(foldSourceFreshness([state({ sourceId: "aider", status: "picker-only" })])).toBe("stale")
  })
})
