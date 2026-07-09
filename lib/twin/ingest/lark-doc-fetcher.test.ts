import {
  LARK_FORBIDDEN_CODES,
  LarkIngestError,
  fetchLarkDocAsRawSource,
  mapLarkError,
  normalizeCliPayload,
} from "./lark-doc-fetcher"
import { LarkApiError } from "@/lib/connectors/adapters/lark/auth-retry"
import type { TauriHttpRequest } from "@/lib/connectors/tauri/commands"

jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn(() => true) }))
jest.mock("@/lib/db/adapter-instances", () => ({ getAdapterInstance: jest.fn() }))
jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsHttpRequest: jest.fn(),
  connectorsKeyringGet: jest.fn(),
}))
jest.mock("@/lib/connectors/adapters/lark/auth", () => ({
  getUserAccessToken: jest.fn(),
  getTenantAccessToken: jest.fn(),
  refreshUserToken: jest.fn(),
  clearTokenCache: jest.fn(),
}))

import { isTauri } from "@/lib/tauri"
import { getAdapterInstance } from "@/lib/db/adapter-instances"
import { connectorsKeyringGet } from "@/lib/connectors/tauri/commands"
import {
  getTenantAccessToken,
  getUserAccessToken,
  refreshUserToken,
} from "@/lib/connectors/adapters/lark/auth"

const isTauriMock = isTauri as jest.Mock
const getAdapterInstanceMock = getAdapterInstance as jest.Mock
const keyringGetMock = connectorsKeyringGet as jest.Mock
const getUserAccessTokenMock = getUserAccessToken as jest.Mock
const getTenantAccessTokenMock = getTenantAccessToken as jest.Mock
const refreshUserTokenMock = refreshUserToken as jest.Mock

const DOCX_URL = "https://acme.feishu.cn/docx/doxcnAbCdEfGh1234567890"
const WIKI_URL = "https://acme.feishu.cn/wiki/wikcnAbCdEfGh123456789"
const ADAPTER = "cai_test1"

function ok(data: unknown) {
  return {
    status: 200,
    headers: {} as Record<string, string>,
    body: JSON.stringify({ code: 0, data }),
  }
}

function larkFail(status: number, code: number, msg = "boom") {
  return { status, headers: {} as Record<string, string>, body: JSON.stringify({ code, msg }) }
}

/** httpImpl stub routing by URL substring. */
function makeHttp(routes: Array<[match: string, resp: unknown]>) {
  return jest.fn(async (req: TauriHttpRequest) => {
    const hit = routes.find(([m]) => req.url.includes(m))
    if (!hit) throw new Error(`unexpected url ${req.url}`)
    return hit[1] as { status: number; headers: Record<string, string>; body: string }
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  isTauriMock.mockReturnValue(true)
  getAdapterInstanceMock.mockResolvedValue({
    id: ADAPTER,
    type: "lark",
    enabled: true,
    displayName: "Acme Lark",
  })
  keyringGetMock.mockImplementation(async (_id: string, cred: string) =>
    cred === "appId" ? "cli_app" : cred === "appSecret" ? "sec" : null
  )
  getUserAccessTokenMock.mockResolvedValue("user-token")
  getTenantAccessTokenMock.mockResolvedValue("tenant-token")
})

async function expectCode(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toMatchObject({ name: "LarkIngestError", code })
}

describe("fetchLarkDocAsRawSource — api channel", () => {
  it("rejects unparseable input", async () => {
    await expectCode(
      fetchLarkDocAsRawSource("https://example.com/post", { adapterId: ADAPTER }),
      "larkInvalidUrl"
    )
  })

  it("fetches a docx via the user token", async () => {
    const http = makeHttp([
      ["/raw_content", ok({ content: "Hello body" })],
      ["/documents/doxcn", ok({ document: { title: "Spec" } })],
    ])
    const doc = await fetchLarkDocAsRawSource(DOCX_URL, { adapterId: ADAPTER, httpImpl: http })
    expect(doc).toMatchObject({
      title: "Spec",
      text: "Hello body",
      docToken: "doxcnAbCdEfGh1234567890",
      objType: "docx",
      adapterId: ADAPTER,
      channel: "api",
    })
    for (const call of http.mock.calls) {
      expect(call[0].headers?.Authorization).toBe("Bearer user-token")
    }
  })

  it("resolves a wiki node to its docx and keeps the node title", async () => {
    const http = makeHttp([
      [
        "/wiki/v2/spaces/get_node",
        ok({
          node: { obj_token: "doxcnResolvedToken123456", obj_type: "docx", title: "Wiki page" },
        }),
      ],
      ["/raw_content", ok({ content: "wiki body" })],
    ])
    const doc = await fetchLarkDocAsRawSource(WIKI_URL, { adapterId: ADAPTER, httpImpl: http })
    expect(doc).toMatchObject({
      title: "Wiki page",
      text: "wiki body",
      docToken: "doxcnResolvedToken123456",
      wikiToken: "wikcnAbCdEfGh123456789",
    })
    // Title came from the node — no extra metadata call.
    expect(http).toHaveBeenCalledTimes(2)
  })

  it("rejects wiki nodes of unsupported object types", async () => {
    const http = makeHttp([
      ["/wiki/v2/spaces/get_node", ok({ node: { obj_token: "sht1", obj_type: "sheet" } })],
    ])
    await expect(
      fetchLarkDocAsRawSource(WIKI_URL, { adapterId: ADAPTER, httpImpl: http })
    ).rejects.toMatchObject({ code: "larkUnsupportedType", params: { type: "sheet" } })
  })

  it("refreshes the user token once on invalidation and retries", async () => {
    let calls = 0
    const http = jest.fn(async (req: TauriHttpRequest) => {
      if (req.url.includes("/raw_content")) {
        calls++
        if (calls === 1) return larkFail(401, 99991677)
        return ok({ content: "after refresh" })
      }
      return ok({ document: { title: "T" } })
    })
    refreshUserTokenMock.mockResolvedValue("user-token-2")
    getUserAccessTokenMock
      .mockResolvedValueOnce("user-token") // presence check
      .mockResolvedValueOnce("user-token") // first attempt
      .mockResolvedValue("user-token-2") // after refresh
    const doc = await fetchLarkDocAsRawSource(DOCX_URL, { adapterId: ADAPTER, httpImpl: http })
    expect(doc.text).toBe("after refresh")
    expect(refreshUserTokenMock).toHaveBeenCalledTimes(1)
  })

  it("falls back to the tenant token when no user is connected", async () => {
    getUserAccessTokenMock.mockResolvedValue(null)
    const http = makeHttp([
      ["/raw_content", ok({ content: "bot body" })],
      ["/documents/doxcn", ok({ document: { title: "T" } })],
    ])
    await fetchLarkDocAsRawSource(DOCX_URL, { adapterId: ADAPTER, httpImpl: http })
    expect(http.mock.calls[0][0].headers?.Authorization).toBe("Bearer tenant-token")
  })

  it("falls back to the tenant token when refresh cannot revive the user", async () => {
    refreshUserTokenMock.mockRejectedValue(
      new Error("Lark user token refresh: no refresh token stored")
    )
    let sawTenant = false
    const http = jest.fn(async (req: TauriHttpRequest) => {
      if (req.headers?.Authorization === "Bearer user-token") return larkFail(401, 99991677)
      sawTenant = true
      if (req.url.includes("/raw_content")) return ok({ content: "bot body" })
      return ok({ document: { title: "T" } })
    })
    const doc = await fetchLarkDocAsRawSource(DOCX_URL, { adapterId: ADAPTER, httpImpl: http })
    expect(doc.text).toBe("bot body")
    expect(sawTenant).toBe(true)
  })

  it.each([
    [403, 1254302, "larkNoPermission"],
    [404, 1254005, "larkNotFound"],
    [429, 99991400, "larkRateLimited"],
    [500, 500100, "larkNetwork"],
  ])("maps HTTP %s / code %s to %s", async (status, code, expected) => {
    const http = makeHttp([["/", larkFail(status as number, code as number)]])
    await expectCode(
      fetchLarkDocAsRawSource(DOCX_URL, { adapterId: ADAPTER, httpImpl: http }),
      expected as string
    )
  })

  it("throws larkBrowserUnsupported outside Tauri without touching the network", async () => {
    isTauriMock.mockReturnValue(false)
    await expectCode(
      fetchLarkDocAsRawSource(DOCX_URL, { adapterId: ADAPTER }),
      "larkBrowserUnsupported"
    )
    expect(getAdapterInstanceMock).not.toHaveBeenCalled()
  })

  it("throws larkNoAccount for missing or disabled adapters", async () => {
    getAdapterInstanceMock.mockResolvedValue(undefined)
    await expectCode(
      fetchLarkDocAsRawSource(DOCX_URL, { adapterId: ADAPTER, httpImpl: makeHttp([]) }),
      "larkNoAccount"
    )
    getAdapterInstanceMock.mockResolvedValue({ id: ADAPTER, type: "lark", enabled: false })
    await expectCode(
      fetchLarkDocAsRawSource(DOCX_URL, { adapterId: ADAPTER, httpImpl: makeHttp([]) }),
      "larkNoAccount"
    )
  })

  it("throws larkNotAuthorized when app credentials are missing", async () => {
    keyringGetMock.mockResolvedValue(null)
    await expectCode(
      fetchLarkDocAsRawSource(DOCX_URL, { adapterId: ADAPTER, httpImpl: makeHttp([]) }),
      "larkNotAuthorized"
    )
  })

  it("throws larkEmptyDoc for a blank body", async () => {
    const http = makeHttp([
      ["/raw_content", ok({ content: "   " })],
      ["/documents/doxcn", ok({ document: { title: "T" } })],
    ])
    await expectCode(
      fetchLarkDocAsRawSource(DOCX_URL, { adapterId: ADAPTER, httpImpl: http }),
      "larkEmptyDoc"
    )
  })
})

describe("fetchLarkDocAsRawSource — api channel edge branches", () => {
  it("maps a non-JSON error body to larkNetwork with the HTTP status", async () => {
    const http = makeHttp([["/", { status: 502, headers: {}, body: "<html>bad gateway</html>" }]])
    await expectCode(
      fetchLarkDocAsRawSource(DOCX_URL, { adapterId: ADAPTER, httpImpl: http }),
      "larkNetwork"
    )
  })

  it("fetches legacy /docs/ documents via the doc v2 raw_content endpoint", async () => {
    const urls: string[] = []
    const http = jest.fn(async (req: TauriHttpRequest) => {
      urls.push(req.url)
      return ok({ content: "legacy body" })
    })
    const doc = await fetchLarkDocAsRawSource("https://acme.feishu.cn/docs/doccnLegacyToken12345", {
      adapterId: ADAPTER,
      httpImpl: http,
    })
    expect(urls[0]).toContain("/open-apis/doc/v2/doccnLegacyToken12345/raw_content")
    expect(doc).toMatchObject({
      objType: "doc",
      text: "legacy body",
      title: "doccnLegacyToken12345",
    })
  })

  it("maps a persistent 401 on the tenant path to larkNotAuthorized", async () => {
    getUserAccessTokenMock.mockResolvedValue(null)
    const http = makeHttp([["/", larkFail(401, 99991663)]])
    await expectCode(
      fetchLarkDocAsRawSource(DOCX_URL, { adapterId: ADAPTER, httpImpl: http }),
      "larkNotAuthorized"
    )
  })

  it("rejects wiki nodes lacking an obj_token", async () => {
    const http = makeHttp([["/wiki/v2/spaces/get_node", ok({ node: {} })]])
    await expect(
      fetchLarkDocAsRawSource(WIKI_URL, { adapterId: ADAPTER, httpImpl: http })
    ).rejects.toMatchObject({ code: "larkUnsupportedType", params: { type: "unknown" } })
  })
})

describe("fetchLarkDocAsRawSource — cli channel", () => {
  it("resolves the default exec via dynamic import when none is injected", async () => {
    jest.doMock("@/lib/skills/built-in/lark/exec-lark-cli", () => ({
      execLarkCli: jest.fn(async () => ({
        status: "ok",
        adapterId: ADAPTER,
        data: "cli markdown body",
      })),
    }))
    try {
      const doc = await fetchLarkDocAsRawSource(DOCX_URL, { adapterId: ADAPTER, channel: "cli" })
      expect(doc).toMatchObject({ text: "cli markdown body", channel: "cli" })
    } finally {
      jest.dontMock("@/lib/skills/built-in/lark/exec-lark-cli")
    }
  })

  it("maps a failing dynamic import to larkCliUnavailable", async () => {
    // Purge the ok-mock cached by the previous dynamic import.
    jest.resetModules()
    jest.doMock("@/lib/skills/built-in/lark/exec-lark-cli", () => {
      throw new Error("module unavailable in this bundle")
    })
    try {
      await expectCode(
        fetchLarkDocAsRawSource(DOCX_URL, { adapterId: ADAPTER, channel: "cli" }),
        "larkCliUnavailable"
      )
    } finally {
      jest.dontMock("@/lib/skills/built-in/lark/exec-lark-cli")
      jest.resetModules()
    }
  })

  it("falls back to the doc token as title when neither node nor meta has one", async () => {
    const http = makeHttp([
      [
        "/wiki/v2/spaces/get_node",
        ok({ node: { obj_token: "doxcnResolvedToken123456", obj_type: "docx" } }),
      ],
      ["/raw_content", ok({ content: "body" })],
      ["/documents/doxcn", ok({ document: {} })],
    ])
    const doc = await fetchLarkDocAsRawSource(WIKI_URL, { adapterId: ADAPTER, httpImpl: http })
    expect(doc.title).toBe("doxcnResolvedToken123456")
    expect(http).toHaveBeenCalledTimes(3)
  })

  it("uses the body snippet when the error payload is JSON without msg", async () => {
    const http = makeHttp([
      ["/", { status: 200, headers: {}, body: JSON.stringify({ code: 999 }) }],
    ])
    await expectCode(
      fetchLarkDocAsRawSource(DOCX_URL, { adapterId: ADAPTER, httpImpl: http }),
      "larkNetwork"
    )
  })

  it.each([
    [404, 555001, "larkNotFound"],
    [429, 555002, "larkRateLimited"],
  ])("maps bare HTTP %s with unknown code to %s", async (status, code, expected) => {
    const http = makeHttp([["/", larkFail(status as number, code as number)]])
    await expectCode(
      fetchLarkDocAsRawSource(DOCX_URL, { adapterId: ADAPTER, httpImpl: http }),
      expected as string
    )
  })

  it("maps business not-found codes even on HTTP 200", async () => {
    const http = makeHttp([["/", larkFail(200, 1254005)]])
    await expectCode(
      fetchLarkDocAsRawSource(DOCX_URL, { adapterId: ADAPTER, httpImpl: http }),
      "larkNotFound"
    )
  })

  it("handles an empty error body", async () => {
    const http = makeHttp([["/", { status: 500, headers: {}, body: "" }]])
    await expectCode(
      fetchLarkDocAsRawSource(DOCX_URL, { adapterId: ADAPTER, httpImpl: http }),
      "larkNetwork"
    )
  })

  it("marks the wiki token on cli-channel wiki fetches", async () => {
    const exec = jest.fn(async () => ({
      status: "ok" as const,
      adapterId: ADAPTER,
      data: { markdown: "wiki md", document: { title: "Nested title" } },
    }))
    const doc = await fetchLarkDocAsRawSource(WIKI_URL, {
      adapterId: ADAPTER,
      channel: "cli",
      execImpl: exec,
    })
    expect(doc.wikiToken).toBe("wikcnAbCdEfGh123456789")
    expect(doc.title).toBe("Nested title")
  })

  it("maps a bare 403 with an unknown business code to larkNoPermission", async () => {
    const http = makeHttp([["/", larkFail(403, 555555)]])
    await expect(
      fetchLarkDocAsRawSource(DOCX_URL, { adapterId: ADAPTER, httpImpl: http })
    ).rejects.toMatchObject({ code: "larkNoPermission", params: { account: "Acme Lark" } })
  })

  it("maps a throwing exec (stubbed child_process) to larkCliUnavailable", async () => {
    const exec = jest.fn(async () => {
      throw new Error("execFile is not a function")
    })
    await expectCode(
      fetchLarkDocAsRawSource(DOCX_URL, { adapterId: ADAPTER, channel: "cli", execImpl: exec }),
      "larkCliUnavailable"
    )
  })

  it("maps auth_unavailable to larkCliUnavailable", async () => {
    const exec = jest.fn(async () => ({
      status: "error" as const,
      reason: "auth_unavailable",
      message: "no adapter",
    }))
    await expectCode(
      fetchLarkDocAsRawSource(DOCX_URL, { adapterId: ADAPTER, channel: "cli", execImpl: exec }),
      "larkCliUnavailable"
    )
  })

  it("passes adapterId and doc token to lark-cli and normalizes the payload", async () => {
    const exec = jest.fn(async () => ({
      status: "ok" as const,
      adapterId: ADAPTER,
      data: { data: { markdown: "# Title\n\nBody", title: "Doc via CLI" } },
    }))
    const doc = await fetchLarkDocAsRawSource(DOCX_URL, {
      adapterId: ADAPTER,
      channel: "cli",
      execImpl: exec,
    })
    expect(exec).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterId: ADAPTER,
        args: expect.arrayContaining(["docs", "+fetch", "--doc-token", "doxcnAbCdEfGh1234567890"]),
      })
    )
    expect(doc).toMatchObject({ text: "# Title\n\nBody", title: "Doc via CLI", channel: "cli" })
  })

  it("maps binary_not_found to larkCliUnavailable", async () => {
    const exec = jest.fn(async () => ({
      status: "error" as const,
      reason: "binary_not_found",
      message: "not installed",
    }))
    await expectCode(
      fetchLarkDocAsRawSource(DOCX_URL, { adapterId: ADAPTER, channel: "cli", execImpl: exec }),
      "larkCliUnavailable"
    )
  })

  it("maps other cli failures to larkNetwork", async () => {
    const exec = jest.fn(async () => ({
      status: "error" as const,
      reason: "non_zero_exit",
      message: "exit 1",
    }))
    await expectCode(
      fetchLarkDocAsRawSource(DOCX_URL, { adapterId: ADAPTER, channel: "cli", execImpl: exec }),
      "larkNetwork"
    )
  })

  it("throws larkEmptyDoc when the cli payload has no text", async () => {
    const exec = jest.fn(async () => ({ status: "ok" as const, adapterId: ADAPTER, data: "" }))
    await expectCode(
      fetchLarkDocAsRawSource(DOCX_URL, { adapterId: ADAPTER, channel: "cli", execImpl: exec }),
      "larkEmptyDoc"
    )
  })
})

describe("normalizeCliPayload", () => {
  it("passes raw strings through", () => {
    expect(normalizeCliPayload("plain md")).toEqual({ text: "plain md", title: "" })
  })
  it("reads nested content fields", () => {
    expect(normalizeCliPayload({ content: "c", title: "t" })).toEqual({ text: "c", title: "t" })
    expect(normalizeCliPayload({ data: { text: "x" } })).toEqual({ text: "x", title: "" })
  })
  it("stringifies unknown objects and handles null", () => {
    expect(normalizeCliPayload({ foo: 1 }).text).toContain('"foo": 1')
    expect(normalizeCliPayload(null)).toEqual({ text: "", title: "" })
  })
})

describe("mapLarkError", () => {
  it("keeps LarkIngestError instances", () => {
    const e = new LarkIngestError("larkNotFound")
    expect(mapLarkError(e)).toBe(e)
  })
  it("maps business forbidden codes regardless of HTTP status", () => {
    const code = [...LARK_FORBIDDEN_CODES][0]
    const e = new LarkApiError({ status: 200, code, message: "no" })
    expect(mapLarkError(e, "Acme").code).toBe("larkNoPermission")
  })
  it("maps 401 to larkNotAuthorized and plain errors to larkNetwork", () => {
    expect(mapLarkError(new LarkApiError({ status: 401, code: null, message: "x" })).code).toBe(
      "larkNotAuthorized"
    )
    expect(mapLarkError(new Error("offline")).code).toBe("larkNetwork")
    expect(mapLarkError("weird").code).toBe("larkNetwork")
  })
})
