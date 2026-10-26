import { discoverMagpieModels, MAGPIE_APP_KEY } from "./magpie"
import {
  resetProviderCoreRuntimeAdaptersForTesting,
  setProviderCoreRuntimeAdapters,
} from "./runtime-adapters"

const mockFetch = jest.fn()
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
beforeEach(() => {
  mockFetch.mockReset()
  setProviderCoreRuntimeAdapters({ proxyFetch: mockFetch })
})
afterEach(resetProviderCoreRuntimeAdaptersForTesting)

it("identifies Magpie before reading its dynamic catalog and preserves gateway model ids", async () => {
  mockFetch
    .mockResolvedValueOnce(response({ name: "magpie", version: "0.1.1318" }))
    .mockResolvedValueOnce(
      response({
        data: [
          {
            id: "native/coder",
            display_name: "Native Coder",
            owned_by: "native",
            reasoning: true,
            context_window: 128000,
            max_output_tokens: 8192,
            modalities: { input: ["text", "image"], output: ["text"] },
          },
          { id: "group/work", display_name: "Work group", reasoning: false },
        ],
      })
    )
  const result = await discoverMagpieModels({ baseURL: "http://127.0.0.1:18995/v1/" })
  expect(mockFetch.mock.calls.map(([url]) => url)).toEqual([
    "http://127.0.0.1:18995/api/hello",
    "http://127.0.0.1:18995/v1/models",
  ])
  expect(mockFetch.mock.calls[1][1].headers.Authorization).toBe(`Bearer ${MAGPIE_APP_KEY}`)
  expect(result.version).toBe("0.1.1318")
  expect(result.models).toEqual([
    expect.objectContaining({
      id: "native/coder",
      name: "Native Coder",
      contextLength: 128000,
      maxOutputTokens: 8192,
      supportsVision: true,
      supportsReasoning: true,
    }),
    expect.objectContaining({ id: "group/work", supportsReasoning: false }),
  ])
})

it("refuses another service on the same port without reading its catalog", async () => {
  mockFetch.mockResolvedValueOnce(response({ name: "another-service" }))
  await expect(discoverMagpieModels({})).rejects.toThrow(/Magpie/)
  expect(mockFetch).toHaveBeenCalledTimes(1)
})

it.each([response({}, 503), response({ name: "magpie" })])(
  "reports an unavailable or malformed identity",
  async (reply) => {
    mockFetch.mockResolvedValueOnce(reply)
    await expect(discoverMagpieModels({})).rejects.toThrow()
  }
)

it("reports malformed catalogs and propagates cancellation", async () => {
  mockFetch
    .mockResolvedValueOnce(response({ name: "magpie", version: "test" }))
    .mockResolvedValueOnce(response({ data: [{ id: "" }] }))
  await expect(discoverMagpieModels({})).rejects.toThrow(/model/i)
  mockFetch.mockRejectedValueOnce(new DOMException("Aborted", "AbortError"))
  const controller = new AbortController()
  controller.abort()
  await expect(discoverMagpieModels({ signal: controller.signal })).rejects.toMatchObject({
    name: "AbortError",
  })
})
