import { fetchTwinContext, TWIN_CONTEXT_PATH } from "./context-client"
import { DEV_TOKEN_HEADER } from "../handoff/client"

const endpoint = { baseUrl: "http://127.0.0.1:4242", devToken: "tok" }

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as unknown as Response
}

describe("fetchTwinContext", () => {
  it("returns null when no desktop endpoint resolves", async () => {
    const out = await fetchTwinContext(
      { characterId: "c1", message: "hi" },
      { endpoint: null, fetch: jest.fn() }
    )
    expect(out).toBeNull()
  })

  it("POSTs the request with the dev token and unwraps the bridge envelope", async () => {
    const result = {
      ok: true,
      applied: { systemPrompt: "SP", stable: "S", dynamic: "D" },
      degraded: false,
      sources: [{ title: "Doc", score: 0.9 }],
      styleSampleCount: 1,
    }
    const doFetch = jest.fn(async () => jsonResponse({ ok: true, result }))
    const out = await fetchTwinContext(
      { characterId: "c1", message: "hi", sessionId: "s1" },
      { endpoint, fetch: doFetch as unknown as typeof fetch }
    )
    expect(out).toEqual(result)
    const [url, init] = doFetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${endpoint.baseUrl}${TWIN_CONTEXT_PATH}`)
    expect((init.headers as Record<string, string>)[DEV_TOKEN_HEADER]).toBe("tok")
    expect(JSON.parse(String(init.body))).toEqual({
      characterId: "c1",
      message: "hi",
      sessionId: "s1",
    })
  })

  it("returns null on HTTP errors, renderer failures, and thrown fetches", async () => {
    const httpErr = jest.fn(async () => jsonResponse({}, false))
    expect(
      await fetchTwinContext(
        { characterId: "c1", message: "hi" },
        { endpoint, fetch: httpErr as unknown as typeof fetch }
      )
    ).toBeNull()

    const rendererErr = jest.fn(async () =>
      jsonResponse({ ok: true, result: { ok: false, error: "boom" } })
    )
    expect(
      await fetchTwinContext(
        { characterId: "c1", message: "hi" },
        { endpoint, fetch: rendererErr as unknown as typeof fetch }
      )
    ).toBeNull()

    const thrown = jest.fn(async () => {
      throw new Error("ECONNREFUSED")
    })
    expect(
      await fetchTwinContext(
        { characterId: "c1", message: "hi" },
        { endpoint, fetch: thrown as unknown as typeof fetch }
      )
    ).toBeNull()
  })
})
