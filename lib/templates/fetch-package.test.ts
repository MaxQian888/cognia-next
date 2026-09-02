import { fetchTemplatePackage, TemplatePackageFetchError } from "./fetch-package"

function ok(bytes: Uint8Array, headers: Record<string, string> = {}): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers(headers),
    arrayBuffer: async () => bytes.buffer.slice(0) as ArrayBuffer,
  } as unknown as Response
}

describe("fetchTemplatePackage", () => {
  it("returns the bytes and the URL they came from", async () => {
    const bytes = new Uint8Array([80, 75, 3, 4])
    const fetchImpl = jest.fn(async () => ok(bytes))
    const result = await fetchTemplatePackage("https://example.com/t.cognia-template", {
      fetchImpl,
    })
    expect(Array.from(result.bytes)).toEqual([80, 75, 3, 4])
    expect(result.sourceUrl).toBe("https://example.com/t.cognia-template")
    expect(fetchImpl).toHaveBeenCalledWith("https://example.com/t.cognia-template", {
      redirect: "follow",
    })
  })

  it("refuses a loopback or private target before any request is made", async () => {
    const fetchImpl = jest.fn()
    await expect(
      fetchTemplatePackage("http://127.0.0.1/t.cognia-template", { fetchImpl })
    ).rejects.toThrow(/private\/loopback/i)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("refuses a non-http scheme", async () => {
    await expect(
      fetchTemplatePackage("file:///etc/passwd", { fetchImpl: jest.fn() })
    ).rejects.toThrow(/non-http/i)
  })

  it("rejects on a declared content-length over the ceiling without reading the body", async () => {
    const arrayBuffer = jest.fn()
    const fetchImpl = jest.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          headers: new Headers({ "content-length": "999" }),
          arrayBuffer,
        }) as unknown as Response
    )
    await expect(
      fetchTemplatePackage("https://example.com/t", { fetchImpl, maxBytes: 10 })
    ).rejects.toMatchObject({ reason: "too-large" })
    expect(arrayBuffer).not.toHaveBeenCalled()
  })

  it("rejects a body that overruns the ceiling even when the header lied", async () => {
    const fetchImpl = jest.fn(async () => ok(new Uint8Array(64), { "content-length": "1" }))
    await expect(
      fetchTemplatePackage("https://example.com/t", { fetchImpl, maxBytes: 10 })
    ).rejects.toMatchObject({ reason: "too-large" })
  })

  it("reports an HTTP failure and a transport failure distinctly", async () => {
    const failing = jest.fn(
      async () => ({ ok: false, status: 404, headers: new Headers() }) as unknown as Response
    )
    await expect(
      fetchTemplatePackage("https://example.com/t", { fetchImpl: failing })
    ).rejects.toMatchObject({ reason: "http" })

    const throwing = jest.fn(async () => {
      throw new Error("boom")
    })
    const caught = await fetchTemplatePackage("https://example.com/t", {
      fetchImpl: throwing,
    }).catch((error: unknown) => error)
    expect(caught).toBeInstanceOf(TemplatePackageFetchError)
    expect((caught as TemplatePackageFetchError).reason).toBe("network")
  })
})
