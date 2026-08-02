/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import { getDb } from "./schema"
import {
  checkpointRecording,
  createRecording,
  deleteRecording,
  duplicateRecording,
  getRecording,
  linkRecordingToSkill,
  countRecordingsForSkill,
  listRecordingsForSkill,
  listRecordingsMissingBundles,
  listUnfinishedRecordings,
  setRecordingStatus,
} from "./skill-recordings"

const deleteBundle = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/skills/recording/recorder-client", () => ({
  recordDeleteBundle: (...args: unknown[]) => deleteBundle(...args),
}))

const ID_A = "0191b0e2-1c3a-7a11-9c1a-4d2f6b8c9e01"
const ID_B = "0191b0e2-1c3a-7a11-9c1a-4d2f6b8c9e02"

beforeEach(async () => {
  deleteBundle.mockClear()
  await getDb().skillRecordings.clear()
})

describe("createRecording", () => {
  it("defaults the bundle to the recording id and starts at version 1", async () => {
    const row = await createRecording({ id: ID_A })
    expect(row.bundleId).toBe(ID_A)
    expect(row.status).toBe("recording")
    expect(row.versionNumber).toBe(1)
    expect(row.edits).toEqual({ bySeq: {}, manual: [] })
    expect(await getRecording(ID_A)).toEqual(row)
  })
})

describe("checkpointRecording", () => {
  it("stamps updatedAt so recovery ordering cannot drift", async () => {
    const row = await createRecording({ id: ID_A })
    await new Promise((resolve) => setTimeout(resolve, 2))
    await checkpointRecording(ID_A, { stepCount: 5 })
    const updated = await getRecording(ID_A)
    expect(updated?.stepCount).toBe(5)
    expect(updated?.updatedAt).toBeGreaterThan(row.updatedAt)
  })
})

describe("listRecordingsForSkill", () => {
  it("returns a skill's versions newest first", async () => {
    await createRecording({ id: ID_A, skillId: "sk_1" })
    await new Promise((resolve) => setTimeout(resolve, 2))
    await createRecording({ id: ID_B, skillId: "sk_1", versionNumber: 2 })
    await createRecording({ id: "0191b0e2-1c3a-7a11-9c1a-4d2f6b8c9e03", skillId: "sk_other" })

    const rows = await listRecordingsForSkill("sk_1")
    expect(rows.map((r) => r.id)).toEqual([ID_B, ID_A])
  })
})

describe("countRecordingsForSkill", () => {
  it("counts only this skill's versions", async () => {
    // The detail panel only needs to know whether to offer the Recordings tab;
    // loading every row (each carrying its edits and draft) would be waste.
    await createRecording({ id: ID_A, skillId: "sk_1" })
    await createRecording({ id: ID_B, skillId: "sk_1", versionNumber: 2 })
    await createRecording({ id: "0191b0e2-1c3a-7a11-9c1a-4d2f6b8c9e03", skillId: "sk_other" })

    await expect(countRecordingsForSkill("sk_1")).resolves.toBe(2)
  })

  it("is zero for a hand-written skill", async () => {
    await expect(countRecordingsForSkill("sk_never_recorded")).resolves.toBe(0)
  })

  it("ignores a recording not yet promoted to any skill", async () => {
    await createRecording({ id: ID_A })
    await expect(countRecordingsForSkill("sk_1")).resolves.toBe(0)
  })
})

describe("listUnfinishedRecordings", () => {
  it("excludes saved and discarded rows", async () => {
    await createRecording({ id: ID_A, status: "captured" })
    await createRecording({ id: ID_B, status: "saved" })
    await createRecording({
      id: "0191b0e2-1c3a-7a11-9c1a-4d2f6b8c9e03",
      status: "discarded",
    })
    const rows = await listUnfinishedRecordings()
    expect(rows.map((r) => r.id)).toEqual([ID_A])
  })
})

describe("linkRecordingToSkill", () => {
  it("attaches the skill and marks the row saved", async () => {
    await createRecording({ id: ID_A })
    await linkRecordingToSkill(ID_A, "sk_9")
    const row = await getRecording(ID_A)
    expect(row?.skillId).toBe("sk_9")
    expect(row?.status).toBe("saved")
  })
})

describe("duplicateRecording", () => {
  it("forks over the SAME bundle so the source version stays immutable", async () => {
    await createRecording({ id: ID_A, skillId: "sk_1" })
    await checkpointRecording(ID_A, { status: "saved", stepCount: 4 })

    const copy = await duplicateRecording(ID_A)
    expect(copy).not.toBeNull()
    expect(copy!.id).not.toBe(ID_A)
    expect(copy!.bundleId).toBe(ID_A)
    expect(copy!.versionNumber).toBe(2)
    expect(copy!.status).toBe("drafting")
    expect(copy!.stepCount).toBe(4)

    // The original is untouched — that is the whole point.
    const original = await getRecording(ID_A)
    expect(original?.status).toBe("saved")
    expect(original?.versionNumber).toBe(1)
  })

  it("returns null for an unknown recording", async () => {
    expect(await duplicateRecording("missing")).toBeNull()
  })
})

describe("deleteRecording", () => {
  it("leaves the bundle alone by default", async () => {
    await createRecording({ id: ID_A })
    await deleteRecording(ID_A)
    expect(await getRecording(ID_A)).toBeUndefined()
    expect(deleteBundle).not.toHaveBeenCalled()
  })

  it("destroys the bundle when asked", async () => {
    await createRecording({ id: ID_A })
    await deleteRecording(ID_A, { deleteBundle: true })
    expect(deleteBundle).toHaveBeenCalledWith(ID_A)
  })

  it("keeps a bundle another version still references", async () => {
    await createRecording({ id: ID_A })
    await createRecording({ id: ID_B, bundleId: ID_A })
    await deleteRecording(ID_A, { deleteBundle: true })
    expect(deleteBundle).not.toHaveBeenCalled()

    // Only the last reference may destroy it.
    await deleteRecording(ID_B, { deleteBundle: true })
    expect(deleteBundle).toHaveBeenCalledWith(ID_A)
  })

  it("is harmless for an unknown id", async () => {
    await expect(deleteRecording("missing", { deleteBundle: true })).resolves.toBeUndefined()
    expect(deleteBundle).not.toHaveBeenCalled()
  })
})

describe("listRecordingsMissingBundles", () => {
  it("finds rows whose capture is gone, ignoring saved ones", async () => {
    await createRecording({ id: ID_A, status: "captured" })
    await createRecording({ id: ID_B, status: "saved" })
    const stranded = await listRecordingsMissingBundles([])
    expect(stranded.map((r) => r.id)).toEqual([ID_A])
  })
})

describe("setRecordingStatus", () => {
  it("moves a row to interrupted", async () => {
    await createRecording({ id: ID_A })
    await setRecordingStatus(ID_A, "interrupted")
    expect((await getRecording(ID_A))?.status).toBe("interrupted")
  })
})

describe("the v141 schema", () => {
  it("indexes what the versions tab and recovery actually query", async () => {
    const db = getDb()
    await db.open()
    expect(db.verno).toBeGreaterThanOrEqual(141)
    expect(db.skillRecordings.schema.primKey.name).toBe("id")
    const indexes = db.skillRecordings.schema.indexes.map((index) => index.name)
    expect(indexes).toContain("skillId")
    expect(indexes).toContain("status")
    expect(indexes).toContain("updatedAt")
    expect(indexes).toContain("[skillId+createdAt]")
  })
})

/**
 * The exclusion is by OMISSION from four allow-lists, which means nothing fails
 * if a future change quietly adds it. These assertions convert that omission
 * into something a test can hold onto.
 */
describe("device-local by construction", () => {
  it("is absent from the companion sync handler set", async () => {
    const { SYNC_HANDLER_TABLES } = await import("@/lib/sync/companion-sync")
    expect(SYNC_HANDLER_TABLES).not.toContain("skillRecordings")
  })

  it("is rejected fail-closed by the desktop sync source", async () => {
    const { readDexieDelta } = await import("@/lib/sync/desktop-sync-source")
    await expect(readDexieDelta("skillRecordings" as never, 0)).rejects.toThrow(
      /unknown sync table/
    )
  })

  it("is absent from the clearable-table union used by settings", async () => {
    // A compile-time union, so this asserts the runtime list the UI renders.
    const clear = await import("@/lib/data/clear")
    expect(Object.keys(clear)).not.toContain("skillRecordings")
  })
})
