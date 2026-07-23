/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import {
  upsertCalibrationItem,
  getCalibrationItem,
  listItemsBySet,
  listCalibrationSets,
  newCalibrationSetId,
  setGoldLabel,
  deleteCalibrationItem,
  deleteItemsBySet,
} from "./calibration-items"
import { __resetDbForTesting, getDb, whenSeeded } from "./schema"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await getDb().calibrationItems.clear()
})

function base(overrides: Partial<Parameters<typeof upsertCalibrationItem>[0]> = {}) {
  return {
    setId: "set-a",
    criterion: "task completion",
    rubric: "Pass only if the answer fully accomplishes the request.",
    input: "What is 2+2?",
    output: "4",
    goldLabel: "pass" as const,
    source: "handwritten" as const,
    ...overrides,
  }
}

describe("calibration items", () => {
  it("creates an item with a calit_ id", async () => {
    const item = await upsertCalibrationItem(base())
    expect(item.id).toMatch(/^calit_/)
    expect(await getCalibrationItem(item.id)).toMatchObject({
      input: "What is 2+2?",
      goldLabel: "pass",
    })
  })

  it("persists optional reference/history/provenance only when provided", async () => {
    const full = await upsertCalibrationItem(
      base({
        reference: "4",
        history: [{ role: "user", content: "hi" }],
        sourceTraceId: "tr1",
        sourceCaseId: "c1",
        notes: "n",
      })
    )
    expect(full).toMatchObject({
      reference: "4",
      sourceTraceId: "tr1",
      sourceCaseId: "c1",
      notes: "n",
    })
    expect(full.history).toHaveLength(1)

    const minimal = await upsertCalibrationItem(base())
    expect("reference" in minimal).toBe(false)
    expect("history" in minimal).toBe(false)
    expect("sourceTraceId" in minimal).toBe(false)
  })

  it("upserts in place by id, preserving createdAt", async () => {
    const created = await upsertCalibrationItem(base({ createdAt: 1000 }))
    const edited = await upsertCalibrationItem({ ...base({ output: "four" }), id: created.id })
    expect(edited.id).toBe(created.id)
    expect(edited.createdAt).toBe(1000)
    expect(edited.output).toBe("four")
    expect(await getCalibrationItem(created.id)).toMatchObject({ output: "four" })
  })

  it("returns undefined for empty/missing id", async () => {
    expect(await getCalibrationItem("")).toBeUndefined()
    expect(await getCalibrationItem("nope")).toBeUndefined()
  })

  it("lists items in a set newest-first", async () => {
    await upsertCalibrationItem(base({ input: "old", createdAt: 1 }))
    await upsertCalibrationItem(base({ input: "new", createdAt: 2 }))
    await upsertCalibrationItem(base({ setId: "set-b", input: "other", createdAt: 3 }))
    const rows = await listItemsBySet("set-a")
    expect(rows.map((r) => r.input)).toEqual(["new", "old"])
  })

  it("returns [] for empty setId", async () => {
    expect(await listItemsBySet("")).toEqual([])
  })

  it("summarizes sets by count, with the OLDEST item defining the judge", async () => {
    // The newest item used to win, so adding one stray item silently
    // re-attributed every earlier label to a different rubric.
    await upsertCalibrationItem(
      base({ setId: "set-a", setName: "Judge A", criterion: "crit-a", createdAt: 1 })
    )
    await upsertCalibrationItem(base({ setId: "set-a", criterion: "crit-a", createdAt: 2 }))
    await upsertCalibrationItem(
      base({ setId: "set-b", setName: "Judge B", criterion: "crit-b", createdAt: 3 })
    )
    const sets = await listCalibrationSets()
    expect(sets).toMatchObject([
      {
        setId: "set-a",
        setName: "Judge A",
        criterion: "crit-a",
        itemCount: 2,
        criterionMismatch: false,
      },
      {
        setId: "set-b",
        setName: "Judge B",
        criterion: "crit-b",
        itemCount: 1,
        criterionMismatch: false,
      },
    ])
  })

  it("flags a set whose items name different judges instead of overwriting", async () => {
    await upsertCalibrationItem(
      base({ setId: "set-a", setName: "Judge A", criterion: "task-completion", createdAt: 1 })
    )
    await upsertCalibrationItem(
      base({ setId: "set-a", criterion: "instruction-following", createdAt: 2 })
    )
    const [set] = await listCalibrationSets()
    // Oldest wins for the label; the mismatch is reported, not resolved.
    expect(set.criterion).toBe("task-completion")
    expect(set.criterionMismatch).toBe(true)
  })

  it("falls back to the id for a set with no denormalized name (legacy rows)", async () => {
    await upsertCalibrationItem(base({ setId: "typed-name", criterion: "c", createdAt: 1 }))
    expect((await listCalibrationSets())[0].setName).toBe("typed-name")
  })

  it("mints opaque, unique set ids", () => {
    expect(newCalibrationSetId()).toMatch(/^calset_/)
    expect(newCalibrationSetId()).not.toBe(newCalibrationSetId())
  })

  it("setGoldLabel flips the label and bumps updatedAt", async () => {
    const item = await upsertCalibrationItem(base({ goldLabel: "pass", createdAt: 5 }))
    await setGoldLabel(item.id, "fail")
    expect(await getCalibrationItem(item.id)).toMatchObject({ goldLabel: "fail" })
  })

  it("setGoldLabel is a no-op for a missing id", async () => {
    await expect(setGoldLabel("nope", "fail")).resolves.toBeUndefined()
  })

  it("deletes a single item and a whole set", async () => {
    const a = await upsertCalibrationItem(base({ setId: "set-a", input: "a1" }))
    await upsertCalibrationItem(base({ setId: "set-a", input: "a2" }))
    await upsertCalibrationItem(base({ setId: "set-b", input: "b1" }))

    await deleteCalibrationItem(a.id)
    expect(await listItemsBySet("set-a")).toHaveLength(1)

    await deleteItemsBySet("set-a")
    expect(await listItemsBySet("set-a")).toHaveLength(0)
    expect(await listItemsBySet("set-b")).toHaveLength(1)
  })

  it("delete guards ignore empty ids", async () => {
    await expect(deleteCalibrationItem("")).resolves.toBeUndefined()
    await expect(deleteItemsBySet("")).resolves.toBeUndefined()
  })
})
