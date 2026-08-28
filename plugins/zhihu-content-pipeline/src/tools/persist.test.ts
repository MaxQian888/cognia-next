import { makePersistTools } from "./persist"
import { TABLES } from "../db/tables"
import { PLUGIN_ID } from "../ids"
import type { PluginDexieAPI } from "@cognia/plugin-sdk"
function fakeDexie() {
  const tables: Record<string, Record<string, jest.Mock>> = {
    [TABLES.research]: { put: jest.fn(async () => undefined) },
    [TABLES.drafts]: { put: jest.fn(async () => undefined) },
  }
  const dexie: PluginDexieAPI = {
    table: jest.fn((name: string) => tables[name]) as unknown as PluginDexieAPI["table"],
    rawDb: jest.fn(),
  }
  return { dexie, tables }
}

describe("makePersistTools", () => {
  it("builds the two plugin-namespaced persistence tools", () => {
    const tools = makePersistTools(fakeDexie().dexie)
    expect(tools.map((t) => t.name)).toEqual(["zhihu_save_research", "zhihu_save_draft"])
    for (const t of tools) {
      expect(t.pluginId).toBe(PLUGIN_ID)
      expect(t.definition.name).toBe(t.name)
      expect(t.definition.parametersSchema).toHaveProperty("type", "object")
    }
  })

  it("zhihu_save_research writes a research row and returns its id", async () => {
    const { dexie, tables } = fakeDexie()
    const [saveResearch] = makePersistTools(dexie)
    const res = (await saveResearch.execute(
      { kind: "data", content: "GDP 5%", sourceUrl: "http://x" },
      {} as never
    )) as { ok: boolean; id: string }
    expect(res.ok).toBe(true)
    expect(res.id).toMatch(/^research_/)
    expect(tables[TABLES.research].put).toHaveBeenCalledTimes(1)
    const row = tables[TABLES.research].put.mock.calls[0][0]
    expect(row).toMatchObject({ kind: "data", content: "GDP 5%", sourceUrl: "http://x" })
  })

  it("zhihu_save_draft writes a draft row (default status draft) and returns id", async () => {
    const { dexie, tables } = fakeDexie()
    const [, saveDraft] = makePersistTools(dexie)
    const res = (await saveDraft.execute(
      { title: "T", markdownBody: "# body", images: ["a.png", 5] },
      {} as never
    )) as { ok: boolean; id: string; status: string }
    expect(res).toMatchObject({ ok: true, status: "draft" })
    expect(res.id).toMatch(/^draft_/)
    const row = tables[TABLES.drafts].put.mock.calls[0][0]
    expect(row).toMatchObject({ title: "T", markdownBody: "# body" })
    expect(row.images).toEqual(["a.png", "5"])
  })

  it("coerces missing/odd args without throwing", async () => {
    const { dexie, tables } = fakeDexie()
    const [saveResearch] = makePersistTools(dexie)
    await saveResearch.execute({ topicId: 42 }, {} as never)
    const row = tables[TABLES.research].put.mock.calls[0][0]
    expect(row.kind).toBe("note")
    expect(row.content).toBe("")
    expect(row.topicId).toBe("42")
  })

  it("zhihu_save_draft defaults images to [] when the arg is absent", async () => {
    const { dexie, tables } = fakeDexie()
    const [, saveDraft] = makePersistTools(dexie)
    await saveDraft.execute({ title: "T", markdownBody: "b" }, {} as never)
    const row = tables[TABLES.drafts].put.mock.calls[0][0]
    expect(row.images).toEqual([])
  })
})
