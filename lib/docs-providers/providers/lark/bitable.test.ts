import type { LarkAuthedApi } from "@/lib/connectors/adapters/lark/authed-api"
import { MAX_BITABLE_ROWS, MAX_BITABLE_TABLES } from "@/lib/docs-providers/limits"
import { bitableColumns, readLarkBitable } from "./bitable"

const APP = "bascnAbCdEfGh1234567890"

function fakeApi(gets: Array<[string, unknown]>, posts: Array<[string, unknown]>) {
  const paths: string[] = []
  const api: LarkAuthedApi = {
    get: async <T>(path: string) => {
      paths.push(path)
      const hit = gets.find(([m]) => path.includes(m))
      if (!hit) throw new Error(`unexpected GET ${path}`)
      return hit[1] as T
    },
    post: async <T>(path: string) => {
      paths.push(path)
      const hit = posts.find(([m]) => path.includes(m))
      if (!hit) throw new Error(`unexpected POST ${path}`)
      return hit[1] as T
    },
  }
  return { api, paths }
}

describe("bitableColumns", () => {
  it("keeps first-seen order and unions fields across records", () => {
    expect(bitableColumns([{ fields: { a: 1, b: 2 } }, { fields: { b: 3, c: 4 } }])).toEqual([
      "a",
      "b",
      "c",
    ])
  })

  it("tolerates records with no fields", () => {
    expect(bitableColumns([{}, { fields: {} }])).toEqual([])
  })
})

describe("readLarkBitable", () => {
  it("renders one section per table with a fixed header row", async () => {
    const { api } = fakeApi(
      [
        [`/bitable/v1/apps/${APP}/tables`, { items: [{ table_id: "t1", name: "Tasks" }] }],
        [`/bitable/v1/apps/${APP}`, { app: { name: "Roadmap" } }],
      ],
      [
        [
          "/tables/t1/records/search",
          { items: [{ fields: { Name: "Ship", Done: false } }, { fields: { Name: "Plan" } }] },
        ],
      ]
    )
    const out = await readLarkBitable(api, APP)
    expect(out.title).toBe("Roadmap")
    expect(out.truncated).toBe(false)
    // Row 2 is missing `Done`; it must land as an empty trailing cell, not shift.
    expect(out.text).toBe("## Tasks\nName,Done\nShip,false\nPlan,")
  })

  it("JSON-encodes structured field values instead of dropping them", async () => {
    const { api } = fakeApi(
      [
        [`/bitable/v1/apps/${APP}/tables`, { items: [{ table_id: "t1", name: "T" }] }],
        [`/bitable/v1/apps/${APP}`, { app: { name: "A" } }],
      ],
      [["/records/search", { items: [{ fields: { Link: [{ text: "x" }] } }] }]]
    )
    const out = await readLarkBitable(api, APP)
    expect(out.text).toContain('"[{""text"":""x""}]"')
  })

  it("flags and marks a table whose records were paged off", async () => {
    const { api } = fakeApi(
      [
        [`/bitable/v1/apps/${APP}/tables`, { items: [{ table_id: "t1", name: "Big" }] }],
        [`/bitable/v1/apps/${APP}`, { app: { name: "A" } }],
      ],
      [["/records/search", { items: [{ fields: { a: 1 } }], has_more: true }]]
    )
    const out = await readLarkBitable(api, APP)
    expect(out.truncated).toBe(true)
    expect(out.text).toContain("table “Big”")
    expect(out.text).toContain(`${MAX_BITABLE_ROWS} records`)
  })

  it("flags and marks an app with more tables than the cap", async () => {
    const items = Array.from({ length: MAX_BITABLE_TABLES + 1 }, (_, i) => ({
      table_id: `t${i}`,
      name: `T${i}`,
    }))
    const { api } = fakeApi(
      [
        [`/bitable/v1/apps/${APP}/tables`, { items }],
        [`/bitable/v1/apps/${APP}`, { app: { name: "A" } }],
      ],
      [["/records/search", { items: [] }]]
    )
    const out = await readLarkBitable(api, APP)
    expect(out.truncated).toBe(true)
    expect(out.text).toContain(`${MAX_BITABLE_TABLES} tables`)
    expect(out.text.match(/## T\d/g)).toHaveLength(MAX_BITABLE_TABLES)
  })

  it("caps the requested page sizes so a huge base cannot be pulled in one call", async () => {
    const { api, paths } = fakeApi(
      [
        [`/bitable/v1/apps/${APP}/tables`, { items: [{ table_id: "t1", name: "T" }] }],
        [`/bitable/v1/apps/${APP}`, { app: { name: "A" } }],
      ],
      [["/records/search", { items: [] }]]
    )
    await readLarkBitable(api, APP)
    expect(paths.some((p) => p.includes(`/tables?page_size=${MAX_BITABLE_TABLES}`))).toBe(true)
    expect(paths.some((p) => p.includes(`records/search?page_size=${MAX_BITABLE_ROWS}`))).toBe(true)
  })

  it("falls back to the app token when the app has no name", async () => {
    const { api } = fakeApi(
      [
        [`/bitable/v1/apps/${APP}/tables`, {}],
        [`/bitable/v1/apps/${APP}`, {}],
      ],
      []
    )
    const out = await readLarkBitable(api, APP)
    expect(out).toEqual({ title: APP, text: "", truncated: false })
  })
})
