jest.mock("./config", () => ({ getGoogleDocsSettings: jest.fn() }))

import { getGoogleDocsSettings } from "./config"
import type { GoogleHttpFn, GoogleHttpRequest } from "./http"
import { MAX_DOC_CHARS } from "@/lib/docs-providers/limits"
import { __setGoogleProviderDepsForTests, googleDocsProvider } from "./index"

const settingsMock = getGoogleDocsSettings as jest.Mock
const ID = "1AbC_dEfGhIjKlMnOpQrStUvWxYz012345"

function stubHttp(routes: Array<[string, { status?: number; body: string }]>) {
  const urls: string[] = []
  const http: GoogleHttpFn = async (req: GoogleHttpRequest) => {
    urls.push(req.url)
    const hit = routes.find(([m]) => req.url.includes(m))
    if (!hit) throw new Error(`unexpected ${req.url}`)
    return { status: hit[1].status ?? 200, headers: {}, body: hit[1].body }
  }
  __setGoogleProviderDepsForTests({ http, accessToken: async () => "tok" })
  return urls
}

beforeEach(() => {
  jest.clearAllMocks()
  settingsMock.mockResolvedValue({})
  __setGoogleProviderDepsForTests({})
})

afterEach(() => __setGoogleProviderDepsForTests({}))

describe("googleDocsProvider — shape", () => {
  it("declares a colon-terminated prefix and only the kinds Google Workspace has", () => {
    expect(googleDocsProvider.id).toBe("google")
    expect(googleDocsProvider.mentionPrefix).toBe("gdoc:")
    expect(googleDocsProvider.kinds).toEqual(["doc", "sheet"])
    expect(googleDocsProvider.kinds).not.toContain("bitable")
  })

  it("is desktop-only because the installed-app OAuth redirect needs the Rust loopback listener", () => {
    expect(googleDocsProvider.hosts).toEqual(["tauri"])
  })
})

describe("googleDocsProvider.listAccounts", () => {
  it("reports nothing until the connection is complete", async () => {
    settingsMock.mockResolvedValue({ clientId: "cid" })
    expect(await googleDocsProvider.listAccounts()).toEqual([])
  })

  it("reports the connected account, labelled by email", async () => {
    settingsMock.mockResolvedValue({ connected: true, accountEmail: "a@b.c" })
    expect(await googleDocsProvider.listAccounts()).toEqual([{ id: "default", label: "a@b.c" }])
  })

  it("falls back to a generic label when the email is unknown", async () => {
    settingsMock.mockResolvedValue({ connected: true })
    expect(await googleDocsProvider.listAccounts()).toEqual([{ id: "default", label: "Google" }])
  })
})

describe("googleDocsProvider.matchRef", () => {
  it("maps Docs and Sheets URLs and canonicalizes the link", () => {
    expect(
      googleDocsProvider.matchRef(`https://docs.google.com/document/d/${ID}/edit?x=1`)
    ).toEqual({
      kind: "doc",
      id: ID,
      url: `https://docs.google.com/document/d/${ID}/edit`,
    })
    expect(googleDocsProvider.matchRef(`https://docs.google.com/spreadsheets/d/${ID}`)).toEqual({
      kind: "sheet",
      id: ID,
      url: `https://docs.google.com/spreadsheets/d/${ID}/edit`,
    })
  })

  it("returns null for links it cannot read", () => {
    expect(googleDocsProvider.matchRef(`https://docs.google.com/presentation/d/${ID}`)).toBeNull()
    expect(googleDocsProvider.matchRef("hello")).toBeNull()
  })
})

describe("googleDocsProvider.fetch", () => {
  it("exports a Doc and resolves its real name when the ref came from a URL", async () => {
    const urls = stubHttp([
      ["/export?", { body: "# Spec\nbody" }],
      ["/files/", { body: JSON.stringify({ name: "Spec" }) }],
    ])
    const out = await googleDocsProvider.fetch(
      { providerId: "google", kind: "doc", id: ID, title: ID },
      { accountId: "default" }
    )
    expect(out).toEqual({
      ref: { providerId: "google", kind: "doc", id: ID, title: "Spec" },
      title: "Spec",
      text: "# Spec\nbody",
      format: "markdown",
      truncated: false,
    })
    expect(urls.some((u) => u.includes("/files/") && u.includes("fields=name"))).toBe(true)
  })

  it("skips the name lookup when the ref already carries a real title", async () => {
    const urls = stubHttp([["/export?", { body: "body" }]])
    const out = await googleDocsProvider.fetch(
      { providerId: "google", kind: "doc", id: ID, title: "Known" },
      { accountId: "default" }
    )
    expect(out.title).toBe("Known")
    expect(urls.some((u) => u.includes("fields=name"))).toBe(false)
  })

  it("clamps an oversized Doc and reports it", async () => {
    stubHttp([["/export?", { body: "x".repeat(MAX_DOC_CHARS + 5) }]])
    const out = await googleDocsProvider.fetch(
      { providerId: "google", kind: "doc", id: ID, title: "Big" },
      { accountId: "default" }
    )
    expect(out.truncated).toBe(true)
    expect(out.text).toContain("Truncated by Cognia")
  })

  it("refuses to stage an empty Doc", async () => {
    stubHttp([["/export?", { body: "   " }]])
    await expect(
      googleDocsProvider.fetch(
        { providerId: "google", kind: "doc", id: ID, title: "Blank" },
        { accountId: "default" }
      )
    ).rejects.toMatchObject({ code: "empty" })
  })

  it("reads a Sheet as CSV", async () => {
    stubHttp([
      ["values:batchGet", { body: JSON.stringify({ valueRanges: [{ values: [["a", "b"]] }] }) }],
      [
        "spreadsheets/",
        {
          body: JSON.stringify({
            properties: { title: "Budget" },
            sheets: [
              { properties: { title: "Q3", gridProperties: { rowCount: 1, columnCount: 2 } } },
            ],
          }),
        },
      ],
    ])
    const out = await googleDocsProvider.fetch(
      { providerId: "google", kind: "sheet", id: ID, title: ID },
      { accountId: "default" }
    )
    expect(out.format).toBe("csv")
    expect(out.title).toBe("Budget")
    expect(out.text).toBe("## Q3\na,b")
  })

  it("rejects a kind it never advertises", async () => {
    stubHttp([])
    await expect(
      googleDocsProvider.fetch(
        { providerId: "google", kind: "bitable", id: ID, title: "x" },
        { accountId: "default" }
      )
    ).rejects.toMatchObject({ code: "unsupportedType" })
  })

  it("surfaces a permission failure with the provider taxonomy", async () => {
    stubHttp([["/export?", { status: 403, body: JSON.stringify({ error: { message: "nope" } }) }]])
    await expect(
      googleDocsProvider.fetch(
        { providerId: "google", kind: "doc", id: ID, title: "x" },
        { accountId: "default" }
      )
    ).rejects.toMatchObject({ code: "noPermission" })
  })
})

describe("googleDocsProvider.search", () => {
  it("returns refs from Drive", async () => {
    stubHttp([
      [
        "/files?",
        {
          body: JSON.stringify({
            files: [{ id: ID, name: "Spec", mimeType: "application/vnd.google-apps.document" }],
          }),
        },
      ],
    ])
    expect(await googleDocsProvider.search?.("spec", { accountId: "default", limit: 5 })).toEqual([
      {
        providerId: "google",
        kind: "doc",
        id: ID,
        title: "Spec",
        url: `https://docs.google.com/document/d/${ID}/edit`,
      },
    ])
  })
})
