import { encodeHlc } from "./hlc"
import { mergeDelete, mergeUpsert, type RowClocks } from "./merge"

const A = "dev_" + "A".repeat(26)
const B = "dev_" + "B".repeat(26)
const at = (ms: number, deviceId = A) => encodeHlc({ ms, c: 0, deviceId })

describe("mergeUpsert", () => {
  it("creates a missing row with every field", () => {
    expect(mergeUpsert(false, undefined, { a: [1, at(1)], b: [2, at(2)] })).toEqual({
      kind: "write",
      created: true,
      fields: { a: 1, b: 2 },
      clocks: { fields: { a: at(1), b: at(2) } },
    })
  })

  it("keeps the later write per field, and the device id breaks ties", () => {
    const clocks: RowClocks = { fields: { a: at(5), b: at(5, B) } }
    expect(mergeUpsert(true, clocks, { a: [9, at(4)], b: [9, at(6)] })).toEqual({
      kind: "write",
      created: false,
      fields: { b: 9 },
      clocks: { fields: { a: at(5), b: at(6) } },
    })
    // Same time: B > A, so A's write loses to B's.
    expect(mergeUpsert(true, clocks, { b: [1, at(5, A)] })).toEqual({ kind: "ignore" })
    expect(mergeUpsert(true, { fields: { b: at(5, A) } }, { b: [1, at(5, B)] })).toMatchObject({
      kind: "write",
      fields: { b: 1 },
    })
  })

  it("applies a field the row has no clock for", () => {
    expect(mergeUpsert(true, { fields: {} }, { a: [1, at(1)] })).toMatchObject({
      kind: "write",
      fields: { a: 1 },
    })
  })

  it("is idempotent: the same op twice changes nothing the second time", () => {
    const first = mergeUpsert(true, { fields: {} }, { a: [1, at(1)] })
    if (first.kind !== "write") throw new Error("expected a write")
    expect(mergeUpsert(true, first.clocks, { a: [1, at(1)] })).toEqual({ kind: "ignore" })
  })

  it("does not revive a deleted row with an older write, but a newer one recreates it", () => {
    const deleted: RowClocks = { fields: {}, tombstone: at(10) }
    expect(mergeUpsert(false, deleted, { a: [1, at(9)] })).toEqual({ kind: "ignore" })
    expect(mergeUpsert(false, deleted, { a: [1, at(3)], b: [2, at(11)] })).toEqual({
      kind: "write",
      created: true,
      fields: { a: 1, b: 2 },
      clocks: { fields: { a: at(3), b: at(11) }, tombstone: at(10) },
    })
  })

  it("ignores an empty field map", () => {
    expect(mergeUpsert(true, undefined, {})).toEqual({ kind: "ignore" })
  })
})

describe("mergeDelete", () => {
  it("removes the row and records the tombstone", () => {
    expect(mergeDelete(true, { fields: { a: at(1) } }, at(5))).toEqual({
      kind: "delete",
      clocks: { fields: {}, tombstone: at(5) },
    })
    // A delete for a row this device never had still records the tombstone.
    expect(mergeDelete(false, undefined, at(5))).toEqual({
      kind: "delete",
      clocks: { fields: {}, tombstone: at(5) },
    })
  })

  it("loses to a newer edit: the row survives and is re-sent", () => {
    expect(mergeDelete(true, { fields: { a: at(1), b: at(9) } }, at(5))).toEqual({
      kind: "survive",
      clocks: { fields: { a: at(1), b: at(9) }, tombstone: at(5) },
    })
  })

  it("ignores a delete no newer than the last one", () => {
    expect(mergeDelete(false, { fields: {}, tombstone: at(5) }, at(5))).toEqual({ kind: "ignore" })
    expect(mergeDelete(false, { fields: {}, tombstone: at(5) }, at(4))).toEqual({ kind: "ignore" })
  })

  it("converges whichever order a delete and a concurrent newer edit arrive in", () => {
    // Device X deletes at 5; device Y edits b at 9 (it still had the row).
    const start: RowClocks = { fields: { a: at(1), b: at(1) } }
    // On X: the row is gone, then Y's partial edit arrives, then Y's re-sent row.
    const afterDelete = mergeDelete(true, start, at(5))
    if (afterDelete.kind !== "delete") throw new Error("expected a delete")
    const partial = mergeUpsert(false, afterDelete.clocks, { b: ["y", at(9, B)] })
    if (partial.kind !== "write") throw new Error("expected a write")
    const resent = mergeUpsert(true, partial.clocks, {
      a: ["old", at(1)],
      b: ["y", at(9, B)],
    })
    expect(resent).toMatchObject({ kind: "write", fields: { a: "old" } })
    // On Y: the edit came first, then X's delete loses and Y re-sends.
    const onY = mergeDelete(true, { fields: { a: at(1), b: at(9, B) } }, at(5))
    expect(onY.kind).toBe("survive")
  })
})
