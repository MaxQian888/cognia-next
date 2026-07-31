/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb } from "./schema"
import {
  computeImportSourceHash,
  findImportBySourceHash,
  recordMessageImport,
} from "./lark-message-imports"

describe("lark-message-imports", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  afterEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it("hashes selections order-independently", async () => {
    const a = await computeImportSourceHash("lk-1", "oc_1", ["om_2", "om_1"])
    const b = await computeImportSourceHash("lk-1", "oc_1", ["om_1", "om_2"])
    expect(a).toBe(b)
    expect(await computeImportSourceHash("lk-1", "oc_2", ["om_1", "om_2"])).not.toBe(a)
  })

  it("enforces sourceHash uniqueness for replay detection", async () => {
    const sourceHash = await computeImportSourceHash("lk-1", "oc_1", ["om_1"])
    const first = await recordMessageImport({
      sourceHash,
      adapterId: "lk-1",
      chatId: "oc_1",
      conversationKey: "lark:lk-1:oc_1",
      sessionId: "sess_1",
      messageIds: ["om_1"],
      skipped: [{ messageId: "om_gone", reason: "recalled" }],
    })
    expect((await findImportBySourceHash(sourceHash))?.id).toBe(first.id)
    await expect(
      recordMessageImport({
        sourceHash,
        adapterId: "lk-1",
        chatId: "oc_1",
        conversationKey: "lark:lk-1:oc_1",
        sessionId: "sess_2",
        messageIds: ["om_1"],
      })
    ).rejects.toBeDefined()
    expect(await getDb().larkMessageImports.count()).toBe(1)
  })
})

describe("default clock arm", () => {
  it("recordMessageImport stamps createdAt without an explicit now", async () => {
    const row = await recordMessageImport({
      sourceHash: "hash_now",
      adapterId: "lk-1",
      chatId: "oc_1",
      conversationKey: "lark:lk-1:oc_1",
      sessionId: "sess_now",
      messageIds: ["om_1"],
    })
    expect(row.createdAt).toBeGreaterThan(0)
  })
})
