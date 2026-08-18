import { MAX_SHEET_COLS, MAX_SHEET_ROWS, MAX_SHEET_TABS } from "@/lib/docs-providers/limits"
import type { GoogleHttpFn, GoogleHttpRequest } from "./http"
import {
  DOC_EXPORT_FALLBACK_MIME,
  DOC_EXPORT_MIME,
  escapeDriveQueryLiteral,
  exportGoogleDoc,
  getGoogleFileName,
  mapGoogleStatus,
  readGoogleSpreadsheet,
  searchGoogleDocs,
  type GoogleApiContext,
} from "./api"

const ID = "1AbC_dEfGhIjKlMnOpQrStUvWxYz012345"

function ctxWith(routes: Array<[string, { status?: number; body: string }]>): {
  ctx: GoogleApiContext
  urls: string[]
} {
  const urls: string[] = []
  const http: GoogleHttpFn = async (req: GoogleHttpRequest) => {
    urls.push(req.url)
    const hit = routes.find(([m]) => req.url.includes(m))
    if (!hit) throw new Error(`unexpected ${req.url}`)
    return { status: hit[1].status ?? 200, headers: {}, body: hit[1].body }
  }
  return { ctx: { http, accessToken: "tok" }, urls }
}

describe("mapGoogleStatus", () => {
  it.each([
    [401, "notAuthorized"],
    [403, "noPermission"],
    [404, "notFound"],
    [429, "rateLimited"],
    [500, "network"],
  ])("maps HTTP %s to %s", (status, code) => {
    expect(mapGoogleStatus({ status, headers: {}, body: "" })).toMatchObject({ code })
  })

  it("distinguishes a quota 403 from a permission 403", () => {
    expect(
      mapGoogleStatus({
        status: 403,
        headers: {},
        body: JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED", message: "quota" } }),
      })
    ).toMatchObject({ code: "rateLimited" })
  })

  it("carries Google's own message as the reason", () => {
    expect(
      mapGoogleStatus({
        status: 404,
        headers: {},
        body: JSON.stringify({ error: { message: "File not found: x" } }),
      }).params
    ).toEqual({ reason: "File not found: x" })
  })
})

describe("escapeDriveQueryLiteral", () => {
  it("escapes quotes and backslashes so a query cannot restructure the filter", () => {
    expect(escapeDriveQueryLiteral("it's")).toBe("it\\'s")
    expect(escapeDriveQueryLiteral("a\\b")).toBe("a\\\\b")
    expect(escapeDriveQueryLiteral("' or name contains '")).toBe("\\' or name contains \\'")
  })
})

describe("searchGoogleDocs", () => {
  it("returns typed refs with canonical URLs and parsed timestamps", async () => {
    const { ctx } = ctxWith([
      [
        "/files?",
        {
          body: JSON.stringify({
            files: [
              {
                id: ID,
                name: "Spec",
                mimeType: "application/vnd.google-apps.document",
                modifiedTime: "2026-08-01T00:00:00.000Z",
              },
              {
                id: "sheet1234567890abcdef",
                name: "Budget",
                mimeType: "application/vnd.google-apps.spreadsheet",
              },
              {
                id: "slide1234567890abcdef",
                name: "Deck",
                mimeType: "application/vnd.google-apps.presentation",
              },
            ],
          }),
        },
      ],
    ])
    expect(await searchGoogleDocs(ctx, "spec", 10)).toEqual([
      {
        providerId: "google",
        kind: "doc",
        id: ID,
        title: "Spec",
        url: `https://docs.google.com/document/d/${ID}/edit`,
        updatedAtMs: Date.parse("2026-08-01T00:00:00.000Z"),
      },
      {
        providerId: "google",
        kind: "sheet",
        id: "sheet1234567890abcdef",
        title: "Budget",
        url: "https://docs.google.com/spreadsheets/d/sheet1234567890abcdef/edit",
      },
    ])
  })

  it("asks Drive for shared drives too", async () => {
    const { ctx, urls } = ctxWith([["/files?", { body: "{}" }]])
    await searchGoogleDocs(ctx, "x", 5)
    expect(urls[0]).toContain("supportsAllDrives=true")
    expect(urls[0]).toContain("includeItemsFromAllDrives=true")
    expect(urls[0]).toContain("pageSize=5")
  })

  it("clamps an absurd page size", async () => {
    const { ctx, urls } = ctxWith([["/files?", { body: "{}" }]])
    await searchGoogleDocs(ctx, "x", 5000)
    expect(urls[0]).toContain("pageSize=100")
  })

  it("raises a typed error on an HTTP failure", async () => {
    const { ctx } = ctxWith([["/files?", { status: 401, body: "" }]])
    await expect(searchGoogleDocs(ctx, "x", 5)).rejects.toMatchObject({ code: "notAuthorized" })
  })

  it("raises network for a non-JSON success body", async () => {
    const { ctx } = ctxWith([["/files?", { body: "<html>" }]])
    await expect(searchGoogleDocs(ctx, "x", 5)).rejects.toMatchObject({ code: "network" })
  })
})

describe("exportGoogleDoc", () => {
  it("prefers markdown", async () => {
    const { ctx, urls } = ctxWith([["/export?", { body: "# Title" }]])
    expect(await exportGoogleDoc(ctx, ID)).toEqual({ text: "# Title", format: "markdown" })
    expect(urls[0]).toContain(encodeURIComponent(DOC_EXPORT_MIME))
  })

  it("falls back to plain text when markdown is refused with 400", async () => {
    let call = 0
    const http: GoogleHttpFn = async (req) => {
      call += 1
      if (req.url.includes(encodeURIComponent(DOC_EXPORT_MIME))) {
        return { status: 400, headers: {}, body: "" }
      }
      expect(req.url).toContain(encodeURIComponent(DOC_EXPORT_FALLBACK_MIME))
      return { status: 200, headers: {}, body: "plain" }
    }
    const out = await exportGoogleDoc({ http, accessToken: "t" }, ID)
    expect(out).toEqual({ text: "plain", format: "text" })
    expect(call).toBe(2)
  })

  it("does not retry a permission failure as plain text", async () => {
    const { ctx } = ctxWith([["/export?", { status: 403, body: "" }]])
    await expect(exportGoogleDoc(ctx, ID)).rejects.toMatchObject({ code: "noPermission" })
  })
})

describe("getGoogleFileName", () => {
  it("returns the Drive name, falling back to the id", async () => {
    const { ctx } = ctxWith([["/files/", { body: JSON.stringify({ name: " Spec " }) }]])
    expect(await getGoogleFileName(ctx, ID)).toBe("Spec")
    const bare = ctxWith([["/files/", { body: "{}" }]])
    expect(await getGoogleFileName(bare.ctx, ID)).toBe(ID)
  })
})

describe("readGoogleSpreadsheet", () => {
  const meta = (sheets: unknown[]) => JSON.stringify({ properties: { title: "Plan" }, sheets })

  it("reads every visible worksheet through batchGet, one section each", async () => {
    const scoped = ctxWith([
      [
        "values:batchGet",
        { body: JSON.stringify({ valueRanges: [{ values: [["a", "b"]] }, { values: [["c"]] }] }) },
      ],
      [
        "spreadsheets/",
        {
          body: meta([
            { properties: { title: "Q3", gridProperties: { rowCount: 2, columnCount: 2 } } },
            { properties: { title: "Q4", gridProperties: { rowCount: 1, columnCount: 1 } } },
          ]),
        },
      ],
    ])
    const out = await readGoogleSpreadsheet(scoped.ctx, ID)
    expect(out.title).toBe("Plan")
    expect(out.truncated).toBe(false)
    expect(out.text).toBe("## Q3\na,b\n\n## Q4\nc")
    const batch = scoped.urls.find((u) => u.includes("values:batchGet")) as string
    expect(batch).toContain("ranges=")
    expect(batch).toContain("A1%3AB2")
    expect(batch).toContain("A1%3AA1")
  })

  it("quotes worksheet titles and doubles embedded apostrophes in the A1 range", async () => {
    const scoped = ctxWith([
      ["values:batchGet", { body: JSON.stringify({ valueRanges: [{ values: [] }] }) }],
      [
        "spreadsheets/",
        {
          body: meta([
            {
              properties: { title: "Bob's data", gridProperties: { rowCount: 1, columnCount: 1 } },
            },
          ]),
        },
      ],
    ])
    await readGoogleSpreadsheet(scoped.ctx, ID)
    const batch = scoped.urls.find((u) => u.includes("values:batchGet")) as string
    // URLSearchParams encodes the space as `+`; the apostrophe doubling is what matters.
    const ranges = new URL(batch).searchParams.getAll("ranges")
    expect(ranges).toEqual(["'Bob''s data'!A1:A1"])
  })

  it("skips hidden worksheets", async () => {
    const scoped = ctxWith([
      ["values:batchGet", { body: JSON.stringify({ valueRanges: [{ values: [["ok"]] }] }) }],
      [
        "spreadsheets/",
        {
          body: meta([
            { properties: { title: "Shown", gridProperties: { rowCount: 1, columnCount: 1 } } },
            { properties: { title: "Secret", hidden: true } },
          ]),
        },
      ],
    ])
    const out = await readGoogleSpreadsheet(scoped.ctx, ID)
    expect(out.text).toContain("Shown")
    expect(out.text).not.toContain("Secret")
  })

  it("flags and marks a workbook beyond the worksheet cap", async () => {
    const sheets = Array.from({ length: MAX_SHEET_TABS + 1 }, (_, i) => ({
      properties: { title: `T${i}`, gridProperties: { rowCount: 1, columnCount: 1 } },
    }))
    const scoped = ctxWith([
      [
        "values:batchGet",
        {
          body: JSON.stringify({
            valueRanges: sheets.slice(0, MAX_SHEET_TABS).map(() => ({ values: [["x"]] })),
          }),
        },
      ],
      ["spreadsheets/", { body: meta(sheets) }],
    ])
    const out = await readGoogleSpreadsheet(scoped.ctx, ID)
    expect(out.truncated).toBe(true)
    expect(out.text).toContain(`${MAX_SHEET_TABS} worksheets`)
  })

  it("marks an individual worksheet beyond the row/column cap", async () => {
    const scoped = ctxWith([
      ["values:batchGet", { body: JSON.stringify({ valueRanges: [{ values: [["x"]] }] }) }],
      [
        "spreadsheets/",
        {
          body: meta([
            {
              properties: {
                title: "Huge",
                gridProperties: { rowCount: MAX_SHEET_ROWS + 1, columnCount: MAX_SHEET_COLS + 1 },
              },
            },
          ]),
        },
      ],
    ])
    const out = await readGoogleSpreadsheet(scoped.ctx, ID)
    expect(out.truncated).toBe(true)
    expect(out.text).toContain("worksheet “Huge”")
  })

  it("never calls batchGet for a workbook with no visible worksheets", async () => {
    const scoped = ctxWith([["spreadsheets/", { body: meta([]) }]])
    const out = await readGoogleSpreadsheet(scoped.ctx, ID)
    expect(out).toEqual({ title: "Plan", text: "", truncated: false })
    expect(scoped.urls.some((u) => u.includes("batchGet"))).toBe(false)
  })
})
