import { ProviderOperationFailureError } from "../failure"
import {
  authHeaders,
  isAzureOpenAiHost,
  joinUrl,
  providerDownload,
  providerRequest,
  providerUpload,
  restBaseOf,
} from "./http"

describe("provider http helper", () => {
  it("picks the auth header by protocol and keeps static headers", () => {
    expect(
      authHeaders({ protocol: "anthropic", apiKey: "k", headers: { "x-app": "cognia" } })
    ).toEqual({
      "x-app": "cognia",
      "x-api-key": "k",
      "anthropic-version": "2023-06-01",
    })
    expect(authHeaders({ protocol: "openai", apiKey: "k" })).toEqual({ authorization: "Bearer k" })
    expect(authHeaders({ protocol: "google", apiKey: "k" })).toEqual({ "x-goog-api-key": "k" })
    expect(authHeaders({ protocol: "azure", apiKey: "k" })).toEqual({ "api-key": "k" })
    expect(isAzureOpenAiHost("https://acme.openai.azure.com/openai/v1")).toBe(true)
    expect(isAzureOpenAiHost("not a url")).toBe(false)
    expect(
      authHeaders({
        protocol: "openai",
        apiKey: "k",
        baseURL: "https://acme.openai.azure.com/openai/v1",
      })
    ).toEqual({ "api-key": "k" })
    expect(authHeaders({ protocol: "openai", apiKey: undefined })).toEqual({})
    expect(joinUrl("https://a/v1/", "/models")).toBe("https://a/v1/models")
  })

  it("returns parsed JSON and maps a non-2xx to a typed failure", async () => {
    const ok = await providerRequest(
      { protocol: "openai", apiKey: "k", baseURL: "https://a/v1", headers: undefined },
      { path: "models", fetchImpl: async () => new Response('{"data":[]}', { status: 200 }) }
    )
    expect(ok.json).toEqual({ data: [] })
    await expect(
      providerRequest(
        { protocol: "openai", apiKey: "k", baseURL: "https://a/v1", headers: undefined },
        { path: "models", fetchImpl: async () => new Response("nope", { status: 429 }) }
      )
    ).rejects.toMatchObject({ failure: { code: "rate-limited", retryable: true } })
    await expect(
      providerRequest(
        { protocol: "openai", apiKey: "k", baseURL: undefined, headers: undefined },
        { path: "models" }
      )
    ).rejects.toBeInstanceOf(ProviderOperationFailureError)
  })

  it("hangs the anthropic wire under /v1 and leaves every other base alone", () => {
    expect(restBaseOf({ protocol: "anthropic", baseURL: "https://api.anthropic.com" })).toBe(
      "https://api.anthropic.com/v1"
    )
    expect(restBaseOf({ protocol: "anthropic", baseURL: "https://relay/v1/" })).toBe(
      "https://relay/v1/"
    )
    expect(restBaseOf({ protocol: "openai", baseURL: "https://a" })).toBe("https://a")
    expect(restBaseOf({ protocol: "openai", baseURL: undefined })).toBeUndefined()
    expect(restBaseOf({ protocol: "google", baseURL: undefined })).toBe(
      "https://generativelanguage.googleapis.com/v1beta"
    )
    expect(restBaseOf({ protocol: "anthropic", baseURL: undefined })).toBe(
      "https://api.anthropic.com/v1"
    )
  })

  it("uploads multipart without forcing a content type and downloads raw bytes", async () => {
    const provider = {
      protocol: "openai" as const,
      apiKey: "k",
      baseURL: "https://a/v1",
      headers: undefined,
    }
    const form = new FormData()
    form.append("purpose", "assistants")
    const seen: Array<{ url: string; init: RequestInit }> = []
    const uploaded = await providerUpload(provider, {
      path: "files",
      form,
      fetchImpl: async (url, init) => {
        seen.push({ url: String(url), init: init ?? {} })
        return new Response('{"id":"file-1"}', { status: 200 })
      },
    })
    expect(uploaded.json).toEqual({ id: "file-1" })
    expect(seen[0].url).toBe("https://a/v1/files")
    expect(seen[0].init.body).toBe(form)
    expect((seen[0].init.headers as Record<string, string>)["content-type"]).toBeUndefined()
    expect((seen[0].init.headers as Record<string, string>).authorization).toBe("Bearer k")

    const downloaded = await providerDownload(provider, {
      path: "files/file-1/content",
      fetchImpl: async () =>
        new Response(new Uint8Array([1, 2]), {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
    })
    expect([...downloaded.bytes]).toEqual([1, 2])
    expect(downloaded.mimeType).toBe("text/plain")
    await expect(
      providerDownload(provider, {
        path: "x",
        fetchImpl: async () => new Response("gone", { status: 404 }),
      })
    ).rejects.toMatchObject({ failure: { code: "capability-unsupported" } })
  })

  it("sends a pre-encoded raw body with its own content type", async () => {
    const seen: RequestInit[] = []
    await providerRequest(
      { protocol: "google", apiKey: "k", baseURL: "https://g/v1beta", headers: undefined },
      {
        baseURL: "https://g",
        path: "upload/v1beta/files",
        rawBody: { body: "raw", contentType: "multipart/related; boundary=x" },
        fetchImpl: async (_url, init) => {
          seen.push(init ?? {})
          return new Response("{}", { status: 200 })
        },
      }
    )
    expect(seen[0].method).toBe("POST")
    expect(seen[0].body).toBe("raw")
    expect((seen[0].headers as Record<string, string>)["content-type"]).toBe(
      "multipart/related; boundary=x"
    )
  })
})
