import proxyFetch, { proxyFetch as namedFetch } from "./proxy-fetch"

const realFetch = global.fetch

afterEach(() => {
  global.fetch = realFetch
})

describe("proxyFetch", () => {
  it("delegates to global fetch", async () => {
    global.fetch = jest.fn(async () => ({ ok: true }) as Response) as unknown as typeof fetch
    const r = await proxyFetch("https://example.com")
    expect(r.ok).toBe(true)
    expect(global.fetch).toHaveBeenCalledWith("https://example.com")
  })

  it("forwards init args verbatim", async () => {
    const f = jest.fn(async () => ({ ok: true }) as Response)
    global.fetch = f as unknown as typeof fetch
    const init = { method: "POST", body: "x" }
    await proxyFetch("https://api", init)
    expect(f).toHaveBeenCalledWith("https://api", init)
  })

  it("named export and default export are the same function", () => {
    expect(namedFetch).toBe(proxyFetch)
  })
})
