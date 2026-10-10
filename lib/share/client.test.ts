// Coverage for the owner-side share service. Network is mocked; the Dexie
// mirror uses fake-indexeddb. An explicit endpoint is injected so the tests
// don't depend on settings/keyring resolution.

import {
  createShareLink,
  revokeShareLink,
  getShareStats,
  ShareFilesTooLargeError,
  ShareFilesUploadError,
  ShareNotConfiguredError,
  SharePayloadTooLargeError,
  ShareRequestError,
  assertShareRequestSize,
  type CreateShareFile,
  type CreateShareProgress,
} from "./client"
import type { ShareEndpoint } from "./config"
import { decryptShareEnvelope, openShareEnvelope } from "./crypto"
import { downloadShareBlob } from "./blobs"
import { SHARE_MAX_BLOB_BYTES } from "./blob-crypto"
import { bytesShareSource } from "./file-sources"
import { decodeShareKey } from "./keys"
import { listSharedLinks, getSharedLinkByCode } from "@/lib/db/shared-links"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
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

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  await getDb().sharedLinks.clear()
  fetchMock = jest.fn()
  ;(globalThis as { fetch: unknown }).fetch = fetchMock
  // Cold Dexie open walks every schema version and can exceed 5s.
}, 30_000)

function mockFetchOnce(status: number, json: unknown): void {
  fetchMock.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    statusText: `HTTP ${status}`,
    json: async () => json,
  } as Response)
}

afterAll(dbFixture.dispose)

describe("createShareLink", () => {
  it("rejects an encrypted request body that exceeds the upload limit", () => {
    expect(() => assertShareRequestSize("12345678901", 10)).toThrow(SharePayloadTooLargeError)
    expect(() => assertShareRequestSize("1234567890", 10)).not.toThrow()
  })

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

    expect(created.expiresAt).toBe(999)
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
  it("revokes on the original server after settings change without forwarding the new secret", async () => {
    mockFetchOnce(200, { code: "ORIGINAL", ownerToken: "original-owner" })
    await createShareLink({ payload: PAYLOAD }, { ...ENDPOINT, baseUrl: "https://share.test/team" })
    mockFetchOnce(204, {})
    await revokeShareLink("ORIGINAL", { baseUrl: "https://new.test", uploadSecret: "new-secret" })
    expect(fetchMock.mock.calls[1][0]).toBe("https://share.test/team/v1/share/ORIGINAL")
    expect(fetchMock.mock.calls[1][1].headers).toEqual({
      "Content-Type": "application/json",
      "X-Owner-Token": "original-owner",
    })
    expect((await getSharedLinkByCode("ORIGINAL"))?.revoked).toBe(true)
  })

  it("does not falsely revoke a legacy link using another server's upload secret", async () => {
    mockFetchOnce(200, { code: "LEGACY" })
    await createShareLink({ payload: PAYLOAD }, ENDPOINT)
    mockFetchOnce(404, {})
    await expect(
      revokeShareLink("LEGACY", {
        baseUrl: "https://new.test",
        uploadSecret: "new-secret",
      })
    ).rejects.toBeInstanceOf(ShareNotConfiguredError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect((await getSharedLinkByCode("LEGACY"))?.revoked).toBe(false)
  })

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
  it("reads old-link stats on the original server with its owner credential", async () => {
    mockFetchOnce(200, { code: "OLD", ownerToken: "old-owner" })
    await createShareLink({ payload: PAYLOAD }, ENDPOINT)
    mockFetchOnce(200, { viewCount: 4, revoked: false })
    expect(
      await getShareStats("OLD", { baseUrl: "https://new.test", uploadSecret: "new-secret" })
    ).toEqual({ viewCount: 4, revoked: false })
    expect(fetchMock.mock.calls[1][0]).toBe("https://share.test/v1/share/OLD/stats")
    expect(fetchMock.mock.calls[1][1].headers).not.toHaveProperty("Authorization")
  })

  it("supports legacy viewer paths without sending the fragment", async () => {
    mockFetchOnce(200, { code: "LEGACY", ownerToken: "owner" })
    await createShareLink({ payload: PAYLOAD }, ENDPOINT)
    await getDb()
      .sharedLinks.where("code")
      .equals("LEGACY")
      .modify({ url: "https://share.test/team/v/LEGACY" })
    mockFetchOnce(200, { viewCount: 0 })
    await getShareStats("LEGACY", ENDPOINT)
    expect(fetchMock.mock.calls[1][0]).toBe("https://share.test/team/v1/share/LEGACY/stats")
  })

  it.each([
    "invalid-url",
    "file:///share/view",
    "https://user:password@share.test/share/view",
    "https://share.test/unrelated",
  ])("rejects malformed persisted share locations before sending credentials: %s", async (url) => {
    mockFetchOnce(200, { code: "BAD", ownerToken: "owner" })
    await createShareLink({ payload: PAYLOAD }, ENDPOINT)
    await getDb().sharedLinks.where("code").equals("BAD").modify({ url })
    await expect(getShareStats("BAD", ENDPOINT)).rejects.toMatchObject({ status: 400 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

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

it("posts only the non-secret passphrase flag alongside a protected burn envelope", async () => {
  mockFetchOnce(200, { code: "PROTECTED" })
  await createShareLink(
    { payload: PAYLOAD, passphrase: "private phrase", burnAfterRead: true },
    ENDPOINT
  )
  const body = JSON.parse(fetchMock.mock.calls[0][1].body)
  expect(body.passphrase).toBe(true)
  expect(body.burnAfterRead).toBe(true)
  expect(body.envelope.pp).toBeDefined()
  expect(JSON.stringify(body)).not.toContain("private phrase")
})

describe("createShareLink with files (ADR-0222)", () => {
  /** A share server in memory: create, blob upload/commit, delete. */
  function fileServer(
    options: { failPut?: number; failDelete?: boolean; noOwnerToken?: boolean } = {}
  ) {
    const state = {
      envelope: undefined as ShareEnvelopeV1 | undefined,
      chunks: new Map<string, Uint8Array>(),
      committed: new Set<string>(),
      deleted: false,
      puts: 0,
    }
    fetchMock.mockImplementation(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET"
      const path = new URL(url).pathname
      if (method === "POST" && path === "/v1/share") {
        state.envelope = JSON.parse(init.body as string).envelope
        return Response.json({
          code: "FileShare1234",
          ...(options.noOwnerToken ? {} : { ownerToken: "owner" }),
        })
      }
      const blob = /^\/v1\/share\/FileShare1234\/blobs\/([^/]+)\/([^/]+)$/.exec(path)
      if (blob && method === "PUT") {
        state.puts++
        if (options.failPut !== undefined && state.puts > options.failPut) {
          return Response.json({ error: "quota" }, { status: 413 })
        }
        state.chunks.set(`${blob[1]}/${blob[2]}`, new Uint8Array(init.body as ArrayBuffer))
        return new Response(null, { status: 204 })
      }
      if (blob && method === "POST" && blob[2] === "commit") {
        state.committed.add(blob[1])
        return Response.json({ ok: true })
      }
      if (blob && method === "GET") {
        return new Response(state.chunks.get(`${blob[1]}/${blob[2]}`)!.slice())
      }
      if (method === "DELETE" && path === "/v1/share/FileShare1234") {
        if (options.failDelete) return Response.json({ error: "down" }, { status: 503 })
        state.deleted = true
        return new Response(null, { status: 204 })
      }
      return new Response(null, { status: 404 })
    })
    return state
  }

  const file = (path: string, bytes: Uint8Array): CreateShareFile => ({
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    mime: "application/octet-stream",
    open: async () => bytesShareSource(bytes),
  })

  it("seals the manifest into the envelope, uploads the blobs and records a summary", async () => {
    const state = fileServer()
    const report = new TextEncoder().encode("quarterly numbers")
    const progress: CreateShareProgress[] = []
    const created = await createShareLink(
      {
        payload: { kind: "file-bundle", mime: "application/json", data: "", encoding: "utf8" },
        files: [
          file("/workspace/report.txt", report),
          file("/uploads/empty.bin", new Uint8Array()),
        ],
        sessionId: "session-1",
        passphrase: "pw",
        onProgress: (event) => progress.push(event),
      },
      ENDPOINT
    )

    const key = decodeShareKey(created.url.split("#k=")[1])
    const { payload, material } = await openShareEnvelope(state.envelope!, key, "pw")
    expect(payload.files?.map((entry) => [entry.path, entry.size, entry.chunkCount])).toEqual([
      ["/workspace/report.txt", report.length, 1],
      ["/uploads/empty.bin", 0, 0],
    ])
    // Nothing about the files is visible outside the ciphertext.
    expect(JSON.stringify(state.envelope)).not.toContain("report")
    expect(state.committed.size).toBe(1)

    const downloaded = await downloadShareBlob({
      baseUrl: ENDPOINT.baseUrl,
      code: created.code,
      readTicket: "t",
      material,
      entry: payload.files![0],
      fetchImpl: (url, init) => fetchMock(url, init),
    })
    expect(new TextDecoder().decode(await downloaded.arrayBuffer())).toBe("quarterly numbers")

    expect(progress.map((event) => event.phase)).toContain("hashing")
    expect(progress.at(-1)).toMatchObject({
      phase: "uploading",
      done: report.length,
      total: report.length,
    })
    const row = await getSharedLinkByCode(created.code)
    expect(row).toMatchObject({
      kind: "file-bundle",
      sessionId: "session-1",
      files: [
        { path: "/workspace/report.txt", size: report.length, sha256: payload.files![0].sha256 },
        { path: "/uploads/empty.bin", size: 0 },
      ],
    })
  })

  it("withdraws the share and records nothing when an upload fails", async () => {
    const state = fileServer({ failPut: 0 })
    const error = await createShareLink(
      { payload: PAYLOAD, files: [file("/workspace/a.bin", new Uint8Array([1, 2, 3]))] },
      ENDPOINT
    ).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ShareFilesUploadError)
    expect((error as ShareFilesUploadError).revoked).toBe(true)
    expect(state.deleted).toBe(true)
    expect(await listSharedLinks({ includeRevoked: true })).toEqual([])
  })

  it("keeps the link in My Shares when it could not be withdrawn", async () => {
    fileServer({ failPut: 0, failDelete: true })
    const error = await createShareLink(
      { payload: PAYLOAD, files: [file("/workspace/a.bin", new Uint8Array([1]))] },
      ENDPOINT
    ).catch((caught: unknown) => caught)
    expect((error as ShareFilesUploadError).revoked).toBe(false)
    expect((await listSharedLinks()).map((row) => row.code)).toEqual(["FileShare1234"])
  })

  it("refuses a server that mints no owner token, withdrawing nothing it cannot", async () => {
    const state = fileServer({ noOwnerToken: true })
    const error = await createShareLink(
      { payload: PAYLOAD, files: [file("/workspace/a.bin", new Uint8Array([1]))] },
      ENDPOINT
    ).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ShareFilesUploadError)
    expect(state.puts).toBe(0)
  })

  it("checks the server's limits before creating anything", async () => {
    fileServer()
    const huge: CreateShareFile = {
      path: "/workspace/huge.iso",
      name: "huge.iso",
      mime: "application/octet-stream",
      open: async () => ({ size: SHARE_MAX_BLOB_BYTES + 1, read: async () => new Uint8Array() }),
    }
    await expect(
      createShareLink({ payload: PAYLOAD, files: [huge] }, ENDPOINT)
    ).rejects.toBeInstanceOf(ShareFilesTooLargeError)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
