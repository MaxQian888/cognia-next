// Coverage for the owner-side share service. Network is mocked; the Dexie
// mirror uses fake-indexeddb. An explicit endpoint is injected so the tests
// don't depend on settings/keyring resolution.

import "fake-indexeddb/auto"
import {
  createShareLink,
  revokeShareLink,
  getShareStats,
  ShareNotConfiguredError,
  ShareRequestError,
} from "./client"
import type { ShareEndpoint } from "./config"
import { decryptShareEnvelope } from "./crypto"
import { decodeShareKey } from "./keys"
import { listSharedLinks, getSharedLinkByCode } from "@/lib/db/shared-links"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { getPluginEventHooks } from "@/lib/plugin/messaging/hooks-system"
import type { SharePayload, ShareEnvelopeV1 } from "./types"

const ENDPOINT: ShareEndpoint = { baseUrl: "https://share.test", uploadSecret: "sekret" }

const PAYLOAD: SharePayload = {
  kind: "chat-html",
  mime: "text/html",
  data: "<p>hi</p>",
  encoding: "utf8",
  title: "Greeting",
}

let fetchMock: jest.Mock

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await getDb().sharedLinks.clear()
  fetchMock = jest.fn()
  ;(globalThis as { fetch: unknown }).fetch = fetchMock
})

function mockFetchOnce(status: number, json: unknown): void {
  fetchMock.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    statusText: `HTTP ${status}`,
    json: async () => json,
  } as Response)
}

describe("createShareLink", () => {
  it("encrypts, posts the envelope, and returns a url whose #fragment key decrypts it", async () => {
    let posted: ShareEnvelopeV1 | undefined
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      posted = body.envelope
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ code: "AbC123", expiresAt: 999 }),
      } as Response
    })

    const created = await createShareLink({ payload: PAYLOAD, ttlSeconds: 3600 }, ENDPOINT)

    expect(created.code).toBe("AbC123")
    expect(created.url).toMatch(/^https:\/\/share\.test\/share\/view\?c=AbC123#k=/)

    // The posted envelope must be opaque — no kind/mime/title leaked.
    expect(posted).toBeDefined()
    expect(JSON.stringify(posted)).not.toContain("chat-html")
    expect(JSON.stringify(posted)).not.toContain("Greeting")

    // The url fragment key round-trips the original payload.
    const keyB64 = created.url.split("#k=")[1]
    const recovered = await decryptShareEnvelope(posted!, decodeShareKey(keyB64))
    expect(recovered).toEqual(PAYLOAD)

    // Mirror row persisted.
    const row = await getSharedLinkByCode("AbC123")
    expect(row).toMatchObject({ kind: "chat-html", title: "Greeting", revoked: false })
  })

  it("maps burnAfterRead to maxViews: 1", async () => {
    let posted: { maxViews?: number; burnAfterRead?: boolean } | undefined
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      posted = JSON.parse(init.body as string)
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ code: "z" }),
      } as Response
    })
    await createShareLink({ payload: PAYLOAD, burnAfterRead: true }, ENDPOINT)
    expect(posted?.maxViews).toBe(1)
    expect(posted?.burnAfterRead).toBe(true)
  })

  it("persists the per-share ownerToken from the create response", async () => {
    mockFetchOnce(200, { code: "OwnTok", ownerToken: "owner-secret-abc123", expiresAt: 1 })
    await createShareLink({ payload: PAYLOAD }, ENDPOINT)
    const row = await getSharedLinkByCode("OwnTok")
    expect(row?.ownerToken).toBe("owner-secret-abc123")
  })

  it("throws ShareNotConfiguredError when no upload secret", async () => {
    await expect(
      createShareLink({ payload: PAYLOAD }, { baseUrl: "https://share.test", uploadSecret: "" })
    ).rejects.toBeInstanceOf(ShareNotConfiguredError)
  })

  it("throws ShareRequestError on a non-2xx response", async () => {
    mockFetchOnce(413, { error: "payload too large" })
    await expect(createShareLink({ payload: PAYLOAD }, ENDPOINT)).rejects.toBeInstanceOf(
      ShareRequestError
    )
  })
})

describe("revokeShareLink", () => {
  it("deletes on the worker and flags the local mirror", async () => {
    mockFetchOnce(200, { code: "REV" })
    await createShareLink({ payload: PAYLOAD }, ENDPOINT)

    mockFetchOnce(204, {})
    await revokeShareLink("REV", ENDPOINT)
    expect((await getSharedLinkByCode("REV"))?.revoked).toBe(true)
    expect(await listSharedLinks()).toHaveLength(0)
  })

  it("treats a 404 as already-gone (still flags locally)", async () => {
    mockFetchOnce(200, { code: "G" })
    await createShareLink({ payload: PAYLOAD }, ENDPOINT)
    mockFetchOnce(404, {})
    await expect(revokeShareLink("G", ENDPOINT)).resolves.toBeUndefined()
    expect((await getSharedLinkByCode("G"))?.revoked).toBe(true)
  })

  it("sends the X-Owner-Token header for an owned share", async () => {
    mockFetchOnce(200, { code: "OWN", ownerToken: "tok-own-1" })
    await createShareLink({ payload: PAYLOAD }, ENDPOINT)

    let sentHeaders: Record<string, string> | undefined
    fetchMock.mockImplementationOnce(async (_url: string, init: RequestInit) => {
      sentHeaders = init.headers as Record<string, string>
      return { ok: true, status: 204, statusText: "No Content", json: async () => ({}) } as Response
    })
    await revokeShareLink("OWN", ENDPOINT)
    expect(sentHeaders?.["X-Owner-Token"]).toBe("tok-own-1")
  })
})

describe("getShareStats", () => {
  it("returns stats on success", async () => {
    mockFetchOnce(200, { viewCount: 3, expiresAt: 5, revoked: false, maxViews: 10 })
    expect(await getShareStats("X", ENDPOINT)).toEqual({
      viewCount: 3,
      expiresAt: 5,
      revoked: false,
      maxViews: 10,
    })
  })

  it("returns null on 404", async () => {
    mockFetchOnce(404, {})
    expect(await getShareStats("X", ENDPOINT)).toBeNull()
  })

  it("sends the X-Owner-Token header when the local row has one", async () => {
    mockFetchOnce(200, { code: "STAT", ownerToken: "tok-stat-1" })
    await createShareLink({ payload: PAYLOAD }, ENDPOINT)

    let sentHeaders: Record<string, string> | undefined
    fetchMock.mockImplementationOnce(async (_url: string, init: RequestInit) => {
      sentHeaders = init.headers as Record<string, string>
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ viewCount: 0, revoked: false }),
      } as Response
    })
    await getShareStats("STAT", ENDPOINT)
    expect(sentHeaders?.["X-Owner-Token"]).toBe("tok-stat-1")
  })
})

describe("plugin share hooks", () => {
  it("fires onShareLinkCreate with a fragment-stripped url (never the #k= key)", async () => {
    const spy = jest.spyOn(getPluginEventHooks(), "dispatchShareLinkCreate")
    mockFetchOnce(200, { code: "HookC", expiresAt: 42 })
    await createShareLink({ payload: PAYLOAD }, ENDPOINT)
    expect(spy).toHaveBeenCalledTimes(1)
    const arg = spy.mock.calls[0][0]
    expect(arg).toMatchObject({
      code: "HookC",
      kind: "chat-html",
      title: "Greeting",
      expiresAt: 42,
    })
    expect(arg.url).toBe("https://share.test/share/view?c=HookC")
    expect(arg.url).not.toContain("#k=")
    spy.mockRestore()
  })

  it("fires onShareLinkRevoke with the code", async () => {
    const spy = jest.spyOn(getPluginEventHooks(), "dispatchShareLinkRevoke")
    mockFetchOnce(204, {})
    await revokeShareLink("RevHook", ENDPOINT)
    expect(spy).toHaveBeenCalledWith("RevHook")
    spy.mockRestore()
  })
})
