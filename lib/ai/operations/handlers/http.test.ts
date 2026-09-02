import { ProviderOperationFailureError } from "../failure"
import { authHeaders, joinUrl, providerRequest } from "./http"

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
})
