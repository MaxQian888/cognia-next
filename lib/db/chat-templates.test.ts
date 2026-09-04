/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"
import {
  createChatTemplate,
  deleteChatTemplate,
  getChatTemplate,
  listChatTemplates,
  recordChatTemplateUse,
  subscribeChatTemplates,
  updateChatTemplate,
} from "./chat-templates"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
})
afterAll(dbFixture.dispose)

describe("createChatTemplate", () => {
  it("derives the declarations from the body when none are supplied", async () => {
    // This is what makes "save what I just wrote" work with no form in the way.
    const row = await createChatTemplate({ name: "Review", body: "review {{module}}" })

    expect(row.params).toEqual([{ id: "module", label: "module", required: true, kind: "string" }])
    expect(row.revision).toBe(1)
    expect(row.usageCount).toBe(0)
  })

  it("keeps declarations the caller wrote", async () => {
    const params = [
      { id: "module", label: "Which module", required: false, kind: "string" as const },
    ]

    const row = await createChatTemplate({ name: "Review", body: "review {{module}}", params })

    expect(row.params).toEqual(params)
  })

  it("mints a readable id that survives two saves in the same millisecond", async () => {
    // The table is keyed `&id`; without a random tail the second save silently
    // overwrites the first.
    const now = jest.spyOn(Date, "now").mockReturnValue(1_700_000_000_000)
    try {
      const a = await createChatTemplate({ name: "Review This PR", body: "x" })
      const b = await createChatTemplate({ name: "Review This PR", body: "x" })

      expect(a.id).toContain("review-this-pr")
      expect(a.id).not.toBe(b.id)
      await expect(getDb().chatTemplates.count()).resolves.toBe(2)
    } finally {
      now.mockRestore()
    }
  })

  it("registers the schema table, so v193 actually shipped", async () => {
    await createChatTemplate({ name: "Review", body: "x" })

    await expect(getDb().chatTemplates.count()).resolves.toBe(1)
  })
})

describe("updateChatTemplate", () => {
  it("bumps the revision when the body changes", async () => {
    const row = await createChatTemplate({ name: "Review", body: "review {{module}}" })

    const next = await updateChatTemplate(row.id, { body: "review {{module}} on {{branch}}" })

    expect(next?.revision).toBe(2)
    expect(next?.params.map((p) => p.id)).toEqual(["module", "branch"])
  })

  it("does NOT bump the revision for a rename", async () => {
    // A draft records the revision it quoted. Bumping on a rename would make
    // every open draft claim to be out of date over a cosmetic edit.
    const row = await createChatTemplate({ name: "Review", body: "review {{module}}" })

    const next = await updateChatTemplate(row.id, { name: "Review a PR" })

    expect(next?.revision).toBe(1)
    expect(next?.name).toBe("Review a PR")
  })

  it("keeps a hand-written declaration when the body is edited around it", async () => {
    const row = await createChatTemplate({
      name: "Review",
      body: "review {{module}}",
      params: [{ id: "module", label: "Which module", required: false, kind: "string" }],
    })

    const next = await updateChatTemplate(row.id, { body: "please review {{module}} today" })

    expect(next?.params).toEqual([
      { id: "module", label: "Which module", required: false, kind: "string" },
    ])
  })

  it("returns undefined for a template that is gone", async () => {
    await expect(updateChatTemplate("tpl_missing", { name: "x" })).resolves.toBeUndefined()
  })
})

describe("recordChatTemplateUse", () => {
  it("remembers the values and counts the use", async () => {
    const row = await createChatTemplate({ name: "Review", body: "review {{module}}" })

    await recordChatTemplateUse(row.id, { module: { kind: "text", value: "auth" } })

    const stored = await getChatTemplate(row.id)
    expect(stored?.lastParams).toEqual({ module: { kind: "text", value: "auth" } })
    expect(stored?.usageCount).toBe(1)
    expect(stored?.lastUsedAt).toBeGreaterThan(0)
  })

  it("does nothing for a template that is gone, rather than throwing", async () => {
    // Callers fire this without awaiting; a throw here would surface as an
    // unhandled rejection after a send that actually succeeded.
    await expect(recordChatTemplateUse("tpl_missing", {})).resolves.toBeUndefined()
  })
})

describe("listChatTemplates", () => {
  it("offers the most recently used first, falling back to most recently edited", async () => {
    // The clock is driven explicitly: two rows written in the same millisecond
    // tie, and a test that depended on how a tie happens to sort would pass or
    // fail on machine speed.
    let clock = 1_000
    const now = jest.spyOn(Date, "now").mockImplementation(() => (clock += 1_000))
    try {
      const older = await createChatTemplate({ name: "Older", body: "a" })
      await createChatTemplate({ name: "Newer", body: "b" })
      // ...used AFTER the newer one was saved, so recency of USE wins over
      // recency of edit.
      await recordChatTemplateUse(older.id, {})

      expect((await listChatTemplates()).map((r) => r.name)).toEqual(["Older", "Newer"])
    } finally {
      now.mockRestore()
    }
  })

  it("is empty before anything is saved", async () => {
    await expect(listChatTemplates()).resolves.toEqual([])
  })
})

describe("deleteChatTemplate", () => {
  it("removes it", async () => {
    const row = await createChatTemplate({ name: "Review", body: "x" })

    await deleteChatTemplate(row.id)

    await expect(getChatTemplate(row.id)).resolves.toBeUndefined()
  })
})

describe("subscribeChatTemplates", () => {
  it("fires for every write that changes what the table contains", async () => {
    const seen: string[] = []
    const stop = subscribeChatTemplates(() => seen.push("changed"))

    const row = await createChatTemplate({ name: "Review", body: "review {{module}}" })
    await updateChatTemplate(row.id, { body: "review {{module}} now" })
    await deleteChatTemplate(row.id)

    expect(seen).toHaveLength(3)
    stop()
  })

  /**
   * The one write that changes nothing anybody projects, and it fires on every
   * send. Rebuilding the catalog projection once per message for a counter it
   * does not carry is work nobody asked for.
   */
  it("stays silent for a use, which only moves counters", async () => {
    const row = await createChatTemplate({ name: "Review", body: "review {{module}}" })
    const seen: string[] = []
    const stop = subscribeChatTemplates(() => seen.push("changed"))

    await recordChatTemplateUse(row.id, { module: { kind: "text", value: "auth" } })

    expect(seen).toEqual([])
    stop()
  })

  it("does not let a broken subscriber take down the save that fired it", async () => {
    const stop = subscribeChatTemplates(() => {
      throw new Error("projection is on fire")
    })

    await expect(createChatTemplate({ name: "Review", body: "x" })).resolves.toMatchObject({
      name: "Review",
    })
    stop()
  })

  it("stops after unsubscribing", async () => {
    const seen: string[] = []
    subscribeChatTemplates(() => seen.push("changed"))()

    await createChatTemplate({ name: "Review", body: "x" })

    expect(seen).toEqual([])
  })
})
