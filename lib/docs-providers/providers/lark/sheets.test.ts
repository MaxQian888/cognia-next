import type { LarkAuthedApi } from "@/lib/connectors/adapters/lark/authed-api"
import { MAX_SHEET_COLS, MAX_SHEET_ROWS, MAX_SHEET_TABS } from "@/lib/docs-providers/limits"
import { readLarkSpreadsheet } from "./sheets"

const TOKEN = "shtcnAbCdEfGh1234567890"

interface Route {
  match: string
  data: unknown
}

function fakeApi(routes: Route[]): { api: LarkAuthedApi; paths: string[] } {
  const paths: string[] = []
  const api: LarkAuthedApi = {
    get: async <T>(path: string) => {
      paths.push(path)
      const hit = routes.find((r) => path.includes(r.match))
      if (!hit) throw new Error(`unexpected GET ${path}`)
      return hit.data as T
    },
    post: async () => {
      throw new Error("sheets reader must not POST")
    },
  }
  return { api, paths }
}

function worksheet(id: string, title: string, extra: Record<string, unknown> = {}) {
  return {
    sheet_id: id,
    title,
    grid_properties: { row_count: 3, column_count: 2 },
    ...extra,
  }
}

describe("readLarkSpreadsheet", () => {
  it("renders every visible worksheet as its own CSV section", async () => {
    const { api } = fakeApi([
      {
        match: `/sheets/v3/spreadsheets/${TOKEN}/sheets/query`,
        data: { sheets: [worksheet("s1", "Q3"), worksheet("s2", "Q4")] },
      },
      { match: `/sheets/v3/spreadsheets/${TOKEN}`, data: { spreadsheet: { title: "Plan" } } },
      {
        match: "values/s1",
        data: {
          valueRange: {
            values: [
              ["a", "b"],
              [1, 2],
            ],
          },
        },
      },
      { match: "values/s2", data: { valueRange: { values: [["c"], [3]] } } },
    ])
    const out = await readLarkSpreadsheet(api, TOKEN)
    expect(out.title).toBe("Plan")
    expect(out.truncated).toBe(false)
    expect(out.text).toBe("## Q3\na,b\n1,2\n\n## Q4\nc\n3")
  })

  it("asks for a bounded A1 range built from the grid properties", async () => {
    const { api, paths } = fakeApi([
      { match: "/sheets/query", data: { sheets: [worksheet("s1", "Q3")] } },
      { match: `/sheets/v3/spreadsheets/${TOKEN}`, data: { spreadsheet: { title: "P" } } },
      { match: "values/", data: { valueRange: { values: [] } } },
    ])
    await readLarkSpreadsheet(api, TOKEN)
    expect(paths.some((p) => p.includes(encodeURIComponent("s1!A1:B3")))).toBe(true)
  })

  it("skips hidden worksheets so the model sees no more than the user does", async () => {
    const { api } = fakeApi([
      {
        match: "/sheets/query",
        data: { sheets: [worksheet("s1", "Shown"), worksheet("s2", "Secret", { hidden: true })] },
      },
      { match: `/sheets/v3/spreadsheets/${TOKEN}`, data: { spreadsheet: { title: "P" } } },
      { match: "values/s1", data: { valueRange: { values: [["ok"]] } } },
    ])
    const out = await readLarkSpreadsheet(api, TOKEN)
    expect(out.text).toContain("Shown")
    expect(out.text).not.toContain("Secret")
  })

  it("flags and marks a workbook with more worksheets than the cap", async () => {
    const sheets = Array.from({ length: MAX_SHEET_TABS + 2 }, (_, i) => worksheet(`s${i}`, `T${i}`))
    const { api } = fakeApi([
      { match: "/sheets/query", data: { sheets } },
      { match: `/sheets/v3/spreadsheets/${TOKEN}`, data: { spreadsheet: { title: "P" } } },
      { match: "values/", data: { valueRange: { values: [["x"]] } } },
    ])
    const out = await readLarkSpreadsheet(api, TOKEN)
    expect(out.truncated).toBe(true)
    expect(out.text).toContain("Truncated by Cognia")
    expect(out.text).toContain(`${MAX_SHEET_TABS} worksheets`)
    expect(out.text.match(/## T\d/g)).toHaveLength(MAX_SHEET_TABS)
  })

  it("marks the individual worksheet when its grid exceeds the row/column cap", async () => {
    const { api } = fakeApi([
      {
        match: "/sheets/query",
        data: {
          sheets: [
            worksheet("s1", "Huge", {
              grid_properties: { row_count: MAX_SHEET_ROWS + 1, column_count: MAX_SHEET_COLS + 1 },
            }),
          ],
        },
      },
      { match: `/sheets/v3/spreadsheets/${TOKEN}`, data: { spreadsheet: { title: "P" } } },
      { match: "values/", data: { valueRange: { values: [["x"]] } } },
    ])
    const out = await readLarkSpreadsheet(api, TOKEN)
    expect(out.truncated).toBe(true)
    expect(out.text).toContain("worksheet “Huge”")
  })

  it("falls back to the token when the workbook has no title, and tolerates empty values", async () => {
    const { api } = fakeApi([
      { match: "/sheets/query", data: {} },
      { match: `/sheets/v3/spreadsheets/${TOKEN}`, data: {} },
    ])
    const out = await readLarkSpreadsheet(api, TOKEN)
    expect(out).toEqual({ title: TOKEN, text: "", truncated: false })
  })
})
