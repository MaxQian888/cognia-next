const resolveShareEndpointMock = jest.fn(async () => ({
  baseUrl: "https://s.test",
  uploadSecret: "up",
}))
jest.mock("./config", () => ({
  resolveShareEndpoint: () => resolveShareEndpointMock(),
}))

const getSharedLinkByCodeMock = jest.fn()
const updateSharedLinkExpiryMock = jest.fn<Promise<void>, unknown[]>(async () => undefined)
jest.mock("@/lib/db/shared-links", () => ({
  getSharedLinkByCode: (...a: unknown[]) => getSharedLinkByCodeMock(...a),
  updateSharedLinkExpiry: (...a: unknown[]) => updateSharedLinkExpiryMock(...a),
}))

jest.mock("./client", () => ({
  ShareNotConfiguredError: class ShareNotConfiguredError extends Error {},
  ShareRequestError: class ShareRequestError extends Error {
    constructor(
      public status: number,
      message: string
    ) {
      super(message)
    }
  },
}))

import { extendShareLink } from "./renew"
import { ShareNotConfiguredError, ShareRequestError } from "./client"

const fetchMock = jest.fn()

beforeEach(() => {
  jest.clearAllMocks()
  global.fetch = fetchMock as unknown as typeof fetch
  resolveShareEndpointMock.mockResolvedValue({ baseUrl: "https://s.test", uploadSecret: "up" })
  getSharedLinkByCodeMock.mockResolvedValue({ ownerToken: "tok" })
})

describe("extendShareLink", () => {
  it("PATCHes the worker with the owner token and mirrors the new expiry", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ expiresAt: 999 }) })
    const expiresAt = await extendShareLink("abc", 3600)
    expect(expiresAt).toBe(999)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://s.test/v1/share/abc")
    expect(init.method).toBe("PATCH")
    expect((init.headers as Record<string, string>)["X-Owner-Token"]).toBe("tok")
    expect(JSON.parse(init.body as string)).toEqual({ ttlSeconds: 3600 })
    expect(updateSharedLinkExpiryMock).toHaveBeenCalledWith("abc", 999)
  })

  it("falls back to the upload-secret bearer when the row has no owner token", async () => {
    getSharedLinkByCodeMock.mockResolvedValue(undefined)
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ expiresAt: 1 }) })
    await extendShareLink("abc", 60)
    const init = fetchMock.mock.calls[0][1]
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer up")
  })

  it("throws ShareRequestError on a non-ok response and skips the local mirror", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "err",
      json: async () => ({ error: "boom" }),
    })
    await expect(extendShareLink("abc", 60)).rejects.toBeInstanceOf(ShareRequestError)
    expect(updateSharedLinkExpiryMock).not.toHaveBeenCalled()
  })

  it("falls back to the status text when the error body is not JSON", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      statusText: "Bad Gateway",
      json: async () => {
        throw new Error("not json")
      },
    })
    await expect(extendShareLink("abc", 60)).rejects.toMatchObject({
      status: 502,
      message: "Bad Gateway",
    })
  })

  it("throws ShareNotConfiguredError when there is neither an owner token nor an upload secret", async () => {
    getSharedLinkByCodeMock.mockResolvedValue(undefined)
    resolveShareEndpointMock.mockResolvedValue({ baseUrl: "https://s.test", uploadSecret: "" })
    await expect(extendShareLink("abc", 60)).rejects.toBeInstanceOf(ShareNotConfiguredError)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
