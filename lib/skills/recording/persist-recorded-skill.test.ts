/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import { getDb } from "@/lib/db/schema"
import { createRecording } from "@/lib/db/skill-recordings"

import { saveRecordedSkill, type SaveRecordedSkillInput } from "./persist-recorded-skill"
import type { GeneratedDraft } from "./state-machine"

const RECORDING_ID = "0191b0e2-1c3a-7a11-9c1a-4d2f6b8c9e01"

const DRAFT: GeneratedDraft = {
  name: "Export the monthly invoice",
  description: "Pulls the current month's invoice out of the billing portal.",
  content: "## Steps\n1. Open billing\n",
  tags: ["billing"],
  category: "custom",
  allowedTools: ["Read"],
}

function input(patch: Partial<SaveRecordedSkillInput> = {}): SaveRecordedSkillInput {
  return {
    recordingId: RECORDING_ID,
    bundleId: RECORDING_ID,
    draft: DRAFT,
    resources: [],
    edits: { bySeq: {}, manual: [] },
    inputVariables: [],
    selectedAssetIds: [],
    generation: null,
    stepCount: 4,
    includedCount: 3,
    bundleBytes: 1024,
    ...patch,
  }
}

const IMAGE = {
  kind: "asset" as const,
  name: "recording-step-001.png",
  path: "assets/recording-step-001.png",
  content: "AAAA",
  encoding: "base64" as const,
  mimeType: "image/png",
}

beforeEach(async () => {
  const db = getDb()
  await db.skills.clear()
  await db.skillResources.clear()
  await db.skillRecordings.clear()
  await createRecording({ id: RECORDING_ID })
})

describe("saveRecordedSkill", () => {
  it("saves the skill switched off", async () => {
    const { skillId } = await saveRecordedSkill(input())
    const skill = await getDb().skills.get(skillId)
    expect(skill?.status).toBe("disabled")
    expect(skill?.source).toBe("generated")
    expect(skill?.isBuiltIn).toBe(false)
    expect(skill?.name).toBe(DRAFT.name)
    expect(skill?.allowedTools).toEqual(["Read"])
  })

  it("writes the screenshot resources", async () => {
    const { skillId, resourceCount } = await saveRecordedSkill(
      input({ resources: [IMAGE, { ...IMAGE, name: "b.png", path: "assets/b.png" }] })
    )
    expect(resourceCount).toBe(2)
    const rows = await getDb().skillResources.where("skillId").equals(skillId).toArray()
    expect(rows.map((r) => r.path).sort()).toEqual([
      "assets/b.png",
      "assets/recording-step-001.png",
    ])
    expect(rows[0].kind).toBe("asset")
  })

  it("drops a duplicate path instead of writing it twice", async () => {
    const { resourceCount } = await saveRecordedSkill(
      input({ resources: [IMAGE, { ...IMAGE, name: "again.png" }] })
    )
    expect(resourceCount).toBe(1)
  })

  it("links the recording to the skill and marks it saved", async () => {
    const { skillId } = await saveRecordedSkill(input())
    const row = await getDb().skillRecordings.get(RECORDING_ID)
    expect(row?.skillId).toBe(skillId)
    expect(row?.status).toBe("saved")
    expect(row?.stepCount).toBe(4)
    expect(row?.includedCount).toBe(3)
    expect(row?.draft).toEqual(DRAFT)
  })

  it("records the generation provenance when there is one", async () => {
    await saveRecordedSkill(
      input({
        generation: {
          provider: "anthropic",
          model: "claude-x",
          locale: "en",
          redacted: true,
          generatedAt: 42,
          promptHash: "abc",
        },
      })
    )
    const row = await getDb().skillRecordings.get(RECORDING_ID)
    expect(row?.generation).toMatchObject({ model: "claude-x", redacted: true, promptHash: "abc" })
  })

  /**
   * The whole reason this module exists rather than reusing `createSkill()`,
   * which does `skills.put()` then `replaceResourcesForSkill()` as two separate
   * writes: a failure between them leaves a skill with no images and no
   * provenance.
   *
   * The scope assertion is the load-bearing one. Whether IndexedDB actually
   * reverts is Dexie's guarantee, not this module's; what this module owns — and
   * what a refactor could silently break — is that all three tables are inside
   * ONE transaction.
   */
  it("writes all three tables inside a single transaction", async () => {
    const db = getDb()
    const transaction = jest.spyOn(db, "transaction")
    await saveRecordedSkill(input({ resources: [IMAGE] }))

    expect(transaction).toHaveBeenCalledTimes(1)
    const [mode, ...rest] = transaction.mock.calls[0] as unknown[]
    expect(mode).toBe("rw")
    const tables = rest.filter((arg) => typeof arg === "object" && arg !== null && "name" in arg)
    expect((tables as { name: string }[]).map((t) => t.name).sort()).toEqual([
      "skillRecordings",
      "skillResources",
      "skills",
    ])
    transaction.mockRestore()
  })

  it("creates no skill when a write inside the transaction fails", async () => {
    const db = getDb()
    const bulkPut = jest
      .spyOn(db.skillResources, "bulkPut")
      .mockRejectedValueOnce(new Error("disk full"))

    await expect(saveRecordedSkill(input({ resources: [IMAGE] }))).rejects.toThrow("disk full")
    expect(await db.skills.count()).toBe(0)

    bulkPut.mockRestore()
  })

  it("leaves the recording row unlinked so nothing points at a skill that is not there", async () => {
    const db = getDb()
    const bulkPut = jest
      .spyOn(db.skillResources, "bulkPut")
      .mockRejectedValueOnce(new Error("disk full"))

    await expect(saveRecordedSkill(input({ resources: [IMAGE] }))).rejects.toThrow("disk full")
    const row = await db.skillRecordings.get(RECORDING_ID)
    expect(row?.status).toBe("recording")
    expect(row?.skillId).toBeUndefined()

    bulkPut.mockRestore()
  })

  it("leaves the recording row intact so the user can simply try again", async () => {
    const db = getDb()
    const put = jest.spyOn(db.skills, "put").mockRejectedValueOnce(new Error("nope"))
    await expect(saveRecordedSkill(input())).rejects.toThrow("nope")
    put.mockRestore()

    // Second attempt succeeds against the same untouched row.
    const { skillId } = await saveRecordedSkill(input())
    expect(await db.skills.get(skillId)).toBeDefined()
  })

  it("gives every resource a distinct id", async () => {
    const { skillId } = await saveRecordedSkill(
      input({
        resources: [IMAGE, { ...IMAGE, name: "b.png", path: "assets/b.png" }],
      })
    )
    const rows = await getDb().skillResources.where("skillId").equals(skillId).toArray()
    expect(new Set(rows.map((r) => r.id)).size).toBe(2)
  })
})
