import {
  parseCandidates,
  buildTopicRow,
  genId,
  createPipelineDb,
  TABLES,
  type TopicRow,
  type DraftRow,
} from "./tables"
import type { PluginDexieAPI } from "@cognia/plugin-sdk"
describe("parseCandidates", () => {
  it("parses a raw JSON array", () => {
    const out = parseCandidates('[{"title":"A","score":90},{"title":"B"}]')
    expect(out).toEqual([
      { title: "A", url: undefined, reason: undefined, score: 90 },
      { title: "B", url: undefined, reason: undefined, score: undefined },
    ])
  })

  it("unwraps { candidates: [...] } and { topics: [...] }", () => {
    expect(parseCandidates('{"candidates":[{"title":"A"}]}')).toHaveLength(1)
    expect(parseCandidates('{"topics":[{"title":"B"}]}')).toHaveLength(1)
  })

  it("extracts a fenced ```json block from prose", () => {
    const text = 'sure:\n```json\n[{"title":"X","url":"u"}]\n```\nthanks'
    expect(parseCandidates(text)).toEqual([
      { title: "X", url: "u", reason: undefined, score: undefined },
    ])
  })

  it("accepts an already-parsed array/object", () => {
    expect(parseCandidates([{ title: "Z", score: "50" }])).toEqual([
      { title: "Z", url: undefined, reason: undefined, score: 50 },
    ])
  })

  it("drops entries without a title and tolerates junk", () => {
    expect(parseCandidates('[{"url":"x"},{"title":"  "},"nope",5]')).toEqual([])
    expect(parseCandidates("not json")).toEqual([])
    expect(parseCandidates(123)).toEqual([])
    expect(parseCandidates("")).toEqual([])
    // Parsed object with neither candidates nor topics → empty list.
    expect(parseCandidates({ foo: 1 })).toEqual([])
    expect(parseCandidates('{"foo":1}')).toEqual([])
  })
})

describe("genId / buildTopicRow", () => {
  it("generates unique prefixed ids", () => {
    const a = genId("topic")
    const b = genId("topic")
    expect(a.startsWith("topic_")).toBe(true)
    expect(a).not.toBe(b)
  })

  it("builds a candidate topic row", () => {
    const row = buildTopicRow({ title: "T", url: "u", reason: "r", score: 80 }, "zhihu-hot")
    expect(row).toMatchObject({
      title: "T",
      url: "u",
      reason: "r",
      score: 80,
      source: "zhihu-hot",
      status: "candidate",
    })
    expect(typeof row.id).toBe("string")
    expect(typeof row.createdAt).toBe("number")
  })
})

describe("createPipelineDb", () => {
  function fakeDexie(seed: { topics?: TopicRow[]; drafts?: DraftRow[] } = {}) {
    const tables: Record<string, Record<string, jest.Mock>> = {
      [TABLES.topics]: {
        bulkPut: jest.fn(async () => undefined),
        toArray: jest.fn(async () => seed.topics ?? []),
        update: jest.fn(async () => 1),
      },
      [TABLES.research]: { put: jest.fn(async () => undefined) },
      [TABLES.drafts]: {
        put: jest.fn(async () => undefined),
        toArray: jest.fn(async () => seed.drafts ?? []),
      },
    }
    const dexie: PluginDexieAPI = {
      table: jest.fn((name: string) => tables[name]) as unknown as PluginDexieAPI["table"],
      rawDb: jest.fn(),
    }
    return { dexie, tables }
  }

  it("saveTopics bulk-puts candidate rows and returns them", async () => {
    const { dexie, tables } = fakeDexie()
    const db = createPipelineDb(dexie)
    const rows = await db.saveTopics([{ title: "A" }, { title: "B" }], "zhihu-hot")
    expect(rows).toHaveLength(2)
    expect(tables[TABLES.topics].bulkPut).toHaveBeenCalledWith(rows)
    expect(rows.every((r) => r.status === "candidate" && r.source === "zhihu-hot")).toBe(true)
  })

  it("saveTopics with no candidates does not touch the table", async () => {
    const { dexie, tables } = fakeDexie()
    const rows = await createPipelineDb(dexie).saveTopics([], "zhihu-hot")
    expect(rows).toEqual([])
    expect(tables[TABLES.topics].bulkPut).not.toHaveBeenCalled()
  })

  it("listTopics filters by status and sorts newest first", async () => {
    const seed: TopicRow[] = [
      { id: "1", title: "old", source: "s", status: "candidate", createdAt: 100 },
      { id: "2", title: "new", source: "s", status: "candidate", createdAt: 200 },
      { id: "3", title: "done", source: "s", status: "done", createdAt: 300 },
    ]
    const db = createPipelineDb(fakeDexie({ topics: seed }).dexie)
    const candidates = await db.listTopics("candidate")
    expect(candidates.map((t) => t.id)).toEqual(["2", "1"])
    expect(await db.listTopics()).toHaveLength(3)
  })

  it("setTopicStatus updates the row", async () => {
    const { dexie, tables } = fakeDexie()
    await createPipelineDb(dexie).setTopicStatus("1", "selected")
    expect(tables[TABLES.topics].update).toHaveBeenCalledWith("1", { status: "selected" })
  })

  it("saveResearch persists a stamped row", async () => {
    const { dexie, tables } = fakeDexie()
    const row = await createPipelineDb(dexie).saveResearch({ kind: "fact", content: "c" })
    expect(row.id).toMatch(/^research_/)
    expect(tables[TABLES.research].put).toHaveBeenCalledWith(row)
  })

  it("saveDraft defaults status to draft and images to []", async () => {
    const { dexie, tables } = fakeDexie()
    const row = await createPipelineDb(dexie).saveDraft({
      title: "T",
      markdownBody: "B",
      images: [],
    })
    expect(row.status).toBe("draft")
    expect(row.images).toEqual([])
    expect(tables[TABLES.drafts].put).toHaveBeenCalledWith(row)
  })

  it("listDrafts sorts newest first", async () => {
    const seed: DraftRow[] = [
      { id: "1", title: "a", markdownBody: "", images: [], status: "draft", createdAt: 10 },
      { id: "2", title: "b", markdownBody: "", images: [], status: "draft", createdAt: 20 },
    ]
    const drafts = await createPipelineDb(fakeDexie({ drafts: seed }).dexie).listDrafts()
    expect(drafts.map((d) => d.id)).toEqual(["2", "1"])
  })
})
