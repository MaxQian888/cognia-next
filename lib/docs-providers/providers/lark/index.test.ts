jest.mock("@/lib/db/adapter-instances", () => ({ listAdapterInstancesByType: jest.fn() }))
jest.mock("@/lib/connectors/adapters/lark/authed-api", () => ({
  ...jest.requireActual("@/lib/connectors/adapters/lark/authed-api"),
  withLarkAuthedApi: jest.fn(),
}))
jest.mock("@/lib/twin/ingest/lark-doc-fetcher", () => ({
  ...jest.requireActual("@/lib/twin/ingest/lark-doc-fetcher"),
  fetchLarkDocAsRawSource: jest.fn(),
}))

import { listAdapterInstancesByType } from "@/lib/db/adapter-instances"
import {
  LarkAccessError,
  withLarkAuthedApi,
  type LarkAuthedApi,
} from "@/lib/connectors/adapters/lark/authed-api"
import { LarkApiError } from "@/lib/connectors/adapters/lark/auth-retry"
import { LarkIngestError, fetchLarkDocAsRawSource } from "@/lib/twin/ingest/lark-doc-fetcher"
import { MAX_DOC_CHARS } from "@/lib/docs-providers/limits"
import { DocsProviderError } from "@/lib/docs-providers/types"
import { larkDocsProvider } from "./index"

const listByTypeMock = listAdapterInstancesByType as jest.Mock
const withAuthMock = withLarkAuthedApi as jest.Mock
const fetchDocMock = fetchLarkDocAsRawSource as jest.Mock

const ACCOUNT = "cai_1"

/**
 * Stubs are written against `unknown` because `LarkAuthedApi`'s methods are
 * generic in their return type — a concrete stub can never satisfy `<T>() => T`,
 * so the cast happens once here rather than at every call site.
 */
interface StubLarkApi {
  get?: (path: string) => Promise<unknown>
  post?: (path: string, body?: unknown) => Promise<unknown>
}

/** Run the provider's callback against a stubbed API, like the real harness does. */
function runWith(api: StubLarkApi) {
  const stub: StubLarkApi = {
    get: async () => {
      throw new Error("unstubbed get")
    },
    post: async () => {
      throw new Error("unstubbed post")
    },
    ...api,
  }
  withAuthMock.mockImplementation(async (_opts: unknown, fn: (a: LarkAuthedApi) => unknown) =>
    fn(stub as unknown as LarkAuthedApi)
  )
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe("larkDocsProvider — shape", () => {
  it("declares a colon-terminated prefix and the four readable kinds", () => {
    expect(larkDocsProvider.id).toBe("lark")
    expect(larkDocsProvider.mentionPrefix).toBe("lark:")
    expect([...larkDocsProvider.kinds].sort()).toEqual(["bitable", "doc", "sheet", "wiki"])
  })

  it("is desktop-only because open.feishu.cn sends no CORS headers", () => {
    expect(larkDocsProvider.hosts).toEqual(["tauri"])
  })
})

describe("larkDocsProvider.listAccounts", () => {
  it("projects enabled Lark adapters and labels the connected OAuth user", async () => {
    listByTypeMock.mockResolvedValue([
      {
        id: "a1",
        enabled: true,
        displayName: "Acme",
        settings: { connectedUser: { name: "Ada" } },
      },
      { id: "a2", enabled: true, displayName: "BotOnly", settings: {} },
      { id: "a3", enabled: false, displayName: "Off", settings: {} },
    ])
    expect(await larkDocsProvider.listAccounts()).toEqual([
      { id: "a1", label: "Acme · Ada" },
      { id: "a2", label: "BotOnly" },
    ])
  })

  it("returns nothing when no Lark account is bound", async () => {
    listByTypeMock.mockResolvedValue([])
    expect(await larkDocsProvider.listAccounts()).toEqual([])
  })
})

describe("larkDocsProvider.matchRef", () => {
  it.each([
    ["https://acme.feishu.cn/docx/doxcnAbCdEfGh1234567890", "doc"],
    ["https://acme.feishu.cn/wiki/wikcnAbCdEfGh123456789", "wiki"],
    ["https://acme.feishu.cn/docs/doccnAbCdEfGh1234567890", "doc"],
    ["https://acme.feishu.cn/sheets/shtcnAbCdEfGh1234567890", "sheet"],
    ["https://acme.feishu.cn/base/bascnAbCdEfGh1234567890", "bitable"],
  ])("maps %s to kind %s and keeps the URL", (input, kind) => {
    expect(larkDocsProvider.matchRef(input)).toEqual({
      kind,
      id: input.split("/").pop(),
      url: input,
    })
  })

  it("accepts a bare token but records no URL for it", () => {
    expect(larkDocsProvider.matchRef("doxcnAbCdEfGh1234567890")).toEqual({
      kind: "doc",
      id: "doxcnAbCdEfGh1234567890",
    })
  })

  it("returns null for anything it cannot read", () => {
    expect(larkDocsProvider.matchRef("https://acme.feishu.cn/slides/slicnAbCdEfGh12345")).toBeNull()
    expect(larkDocsProvider.matchRef("https://github.com/x/y")).toBeNull()
  })
})

describe("larkDocsProvider.search", () => {
  it("demands the user identity the Feishu search endpoint requires", async () => {
    runWith({ post: async () => ({ docs_entities: [] }) })
    await larkDocsProvider.search?.("q", { accountId: ACCOUNT, limit: 10 })
    expect(withAuthMock).toHaveBeenCalledWith(
      expect.objectContaining({ adapterId: ACCOUNT, requireUserIdentity: true }),
      expect.any(Function)
    )
  })

  it("returns typed refs for readable kinds", async () => {
    runWith({
      post: async () => ({
        docs_entities: [
          { docs_token: "doxcn1", docs_type: "doc", title: "Spec" },
          { docs_token: "shtcn1", docs_type: "sheet", title: "Budget" },
          { docs_token: "sli1", docs_type: "slides", title: "Deck" },
        ],
      }),
    })
    expect(await larkDocsProvider.search?.("q", { accountId: ACCOUNT, limit: 10 })).toEqual([
      { providerId: "lark", kind: "doc", id: "doxcn1", title: "Spec" },
      { providerId: "lark", kind: "sheet", id: "shtcn1", title: "Budget" },
    ])
  })

  it("surfaces a missing OAuth connection as notAuthorized, not a bot permission error", async () => {
    withAuthMock.mockRejectedValue(new LarkAccessError("notAuthorized", "Acme"))
    await expect(
      larkDocsProvider.search?.("q", { accountId: ACCOUNT, limit: 10 })
    ).rejects.toMatchObject({ name: "DocsProviderError", code: "notAuthorized" })
  })
})

describe("larkDocsProvider.fetch — documents", () => {
  it("delegates docs and wiki nodes to the existing twin fetcher", async () => {
    fetchDocMock.mockResolvedValue({ title: "Spec", text: "body" })
    const out = await larkDocsProvider.fetch(
      { providerId: "lark", kind: "doc", id: "doxcn1", title: "stale" },
      { accountId: ACCOUNT }
    )
    expect(fetchDocMock).toHaveBeenCalledWith("doxcn1", { adapterId: ACCOUNT })
    expect(out).toEqual({
      ref: { providerId: "lark", kind: "doc", id: "doxcn1", title: "Spec" },
      title: "Spec",
      text: "body",
      format: "text",
      truncated: false,
    })
  })

  it("prefers the captured URL over the bare token so tenant hosts resolve", async () => {
    fetchDocMock.mockResolvedValue({ title: "T", text: "b" })
    await larkDocsProvider.fetch(
      {
        providerId: "lark",
        kind: "wiki",
        id: "wikcn1",
        title: "T",
        url: "https://acme.feishu.cn/wiki/wikcn1",
      },
      { accountId: ACCOUNT }
    )
    expect(fetchDocMock).toHaveBeenCalledWith("https://acme.feishu.cn/wiki/wikcn1", {
      adapterId: ACCOUNT,
    })
  })

  it("clamps an oversized body and reports it", async () => {
    fetchDocMock.mockResolvedValue({ title: "Big", text: "x".repeat(MAX_DOC_CHARS + 10) })
    const out = await larkDocsProvider.fetch(
      { providerId: "lark", kind: "doc", id: "d", title: "Big" },
      { accountId: ACCOUNT }
    )
    expect(out.truncated).toBe(true)
    expect(out.text).toContain("Truncated by Cognia")
  })

  it("translates the ingest error taxonomy into provider codes", async () => {
    fetchDocMock.mockRejectedValue(new LarkIngestError("larkNoPermission", { account: "Acme" }))
    await expect(
      larkDocsProvider.fetch(
        { providerId: "lark", kind: "doc", id: "d", title: "x" },
        { accountId: ACCOUNT }
      )
    ).rejects.toMatchObject({ name: "DocsProviderError", code: "noPermission" })
  })
})

describe("larkDocsProvider.fetch — grids", () => {
  it("reads a spreadsheet as CSV without demanding the user identity", async () => {
    runWith({
      get: async (path: string) =>
        path.includes("/sheets/query")
          ? {
              sheets: [
                { sheet_id: "s1", title: "Q3", grid_properties: { row_count: 1, column_count: 1 } },
              ],
            }
          : path.includes("values/")
            ? { valueRange: { values: [["a"]] } }
            : { spreadsheet: { title: "Budget" } },
    })
    const out = await larkDocsProvider.fetch(
      { providerId: "lark", kind: "sheet", id: "shtcn1", title: "stale" },
      { accountId: ACCOUNT }
    )
    expect(out.format).toBe("csv")
    expect(out.title).toBe("Budget")
    expect(out.text).toBe("## Q3\na")
    expect(withAuthMock.mock.calls[0][0]).not.toHaveProperty("requireUserIdentity", true)
  })

  it("reads a Bitable app as CSV", async () => {
    runWith({
      get: async (path: string) =>
        path.includes("/tables")
          ? { items: [{ table_id: "t1", name: "Tasks" }] }
          : { app: { name: "Road" } },
      post: async () => ({ items: [{ fields: { Name: "Ship" } }] }),
    })
    const out = await larkDocsProvider.fetch(
      { providerId: "lark", kind: "bitable", id: "bascn1", title: "stale" },
      { accountId: ACCOUNT }
    )
    expect(out.title).toBe("Road")
    expect(out.text).toBe("## Tasks\nName\nShip")
  })

  it("reports an empty grid rather than staging a blank attachment", async () => {
    runWith({ get: async () => ({}) })
    await expect(
      larkDocsProvider.fetch(
        { providerId: "lark", kind: "sheet", id: "shtcn1", title: "x" },
        { accountId: ACCOUNT }
      )
    ).rejects.toMatchObject({ code: "empty" })
  })

  it("maps a raw Lark API failure through the shared business-code table", async () => {
    withAuthMock.mockRejectedValue(
      new LarkApiError({ status: 200, code: 1254005, message: "gone" })
    )
    await expect(
      larkDocsProvider.fetch(
        { providerId: "lark", kind: "bitable", id: "b", title: "x" },
        { accountId: ACCOUNT }
      )
    ).rejects.toMatchObject({ code: "notFound" })
  })

  it("passes a DocsProviderError through unchanged", async () => {
    withAuthMock.mockRejectedValue(new DocsProviderError("rateLimited"))
    await expect(
      larkDocsProvider.fetch(
        { providerId: "lark", kind: "sheet", id: "s", title: "x" },
        { accountId: ACCOUNT }
      )
    ).rejects.toMatchObject({ code: "rateLimited" })
  })
})
