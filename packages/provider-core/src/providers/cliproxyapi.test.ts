import {
  CLIProxyAPIError,
  buildModelId,
  checkWebUIAccess,
  fetchModels,
  fetchUsageStats,
  getAPIURL,
  getBaseURL,
  getWebUIURL,
  maskCLIProxyApiKey,
  parseCLIProxyModelId,
  testConnection,
} from "./cliproxyapi"

const fetchMock = jest.fn()

function response(body: unknown, init: { status?: number; statusText?: string } = {}) {
  const status = init.status ?? 200
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: init.statusText ?? "",
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as Response
}

describe("CLIProxyAPI helpers", () => {
  beforeEach(() => {
    fetchMock.mockReset()
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch
  })

  it("builds canonical base, API, and WebUI URLs", () => {
    expect(getBaseURL()).toBe("http://localhost:8317")
    expect(getAPIURL("127.0.0.1", 9000)).toBe("http://127.0.0.1:9000/v1")
    expect(getWebUIURL("proxy.local", 8317)).toBe("http://proxy.local:8317/management.html")
  })

  it("tests connection and reports HTTP failures without throwing", async () => {
    fetchMock.mockResolvedValueOnce(response({ data: [] }))
    await expect(testConnection("key")).resolves.toMatchObject({ success: true })

    fetchMock.mockResolvedValueOnce(
      response("bad key", { status: 401, statusText: "Unauthorized" })
    )
    await expect(testConnection("bad")).resolves.toMatchObject({
      success: false,
      message: expect.stringContaining("401"),
    })
  })

  it("maps OpenAI-compatible model lists and preserves typed API errors", async () => {
    fetchMock.mockResolvedValueOnce(
      response({ data: [{ id: "openai/gpt-4o", owned_by: "openai" }] })
    )
    await expect(fetchModels("key")).resolves.toEqual([
      { id: "openai/gpt-4o", name: "openai/gpt-4o", provider: "openai" },
    ])

    fetchMock.mockResolvedValueOnce(response({}, { status: 500, statusText: "Server Error" }))
    await expect(fetchModels("key")).rejects.toBeInstanceOf(CLIProxyAPIError)
  })

  it("handles management and display helpers", async () => {
    fetchMock.mockResolvedValueOnce(response({ totalRequests: 3 }))
    await expect(fetchUsageStats("management")).resolves.toEqual({ totalRequests: 3 })

    fetchMock.mockResolvedValueOnce(response("", { status: 404 }))
    await expect(checkWebUIAccess()).resolves.toBe(false)

    expect(maskCLIProxyApiKey("abcd1234wxyz")).toBe("abcd...wxyz")
    expect(parseCLIProxyModelId("openai/gpt-4o")).toEqual({ prefix: "openai", model: "gpt-4o" })
    expect(buildModelId("gpt-4o", "openai")).toBe("openai/gpt-4o")
  })
})
