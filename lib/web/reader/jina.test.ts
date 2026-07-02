import { fetchViaJina, parseJinaBody } from "./jina"

function res(body: string, opts: { ok?: boolean; status?: number } = {}): Response {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    headers: { get: () => null },
    text: async () => body,
  } as unknown as Response
}

describe("parseJinaBody", () => {
  it("splits the Jina header into title + markdown", () => {
    const body =
      "Title: Hello World\nURL Source: https://x.test\nMarkdown Content:\n# Hello\n\nBody"
    const r = parseJinaBody(body, "https://x.test")
    expect(r.title).toBe("Hello World")
    expect(r.markdown).toBe("# Hello\n\nBody")
    expect(r.source).toBe("jina")
    expect(r.url).toBe("https://x.test")
  })

  it("treats the whole payload as markdown when markers are absent", () => {
    const r = parseJinaBody("# Just markdown", "u")
    expect(r.markdown).toBe("# Just markdown")
    expect(r.title).toBeUndefined()
  })
})

describe("fetchViaJina", () => {
  it("fetches r.jina.ai and parses the body", async () => {
    const fetchImpl = jest.fn(async () => res("Title: T\nMarkdown Content:\nHi"))
    const r = await fetchViaJina("https://x.test/a", fetchImpl as unknown as typeof fetch)
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://r.jina.ai/https://x.test/a",
      expect.objectContaining({ method: "GET" })
    )
    expect(r?.markdown).toBe("Hi")
    expect(r?.title).toBe("T")
  })

  it("returns null on a non-ok response", async () => {
    const fetchImpl = jest.fn(async () => res("x", { ok: false, status: 500 }))
    expect(await fetchViaJina("u", fetchImpl as unknown as typeof fetch)).toBeNull()
  })

  it("returns null when the fetch throws", async () => {
    const fetchImpl = jest.fn(async () => {
      throw new Error("net")
    })
    expect(await fetchViaJina("u", fetchImpl as unknown as typeof fetch)).toBeNull()
  })

  it("returns null on an empty body", async () => {
    const fetchImpl = jest.fn(async () => res("   "))
    expect(await fetchViaJina("u", fetchImpl as unknown as typeof fetch)).toBeNull()
  })
})
