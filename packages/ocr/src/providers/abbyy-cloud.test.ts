import { abbyyCloudExtract, buildAbbyyCloudProvider } from "./abbyy-cloud"
import type { OcrInput, OcrProviderContext } from "../types"

function makeFetchSequence(
  responses: Array<{ status: number; body: unknown; headers?: Record<string, string> }>
) {
  let i = 0
  return jest.fn(async () => {
    const resp = responses[i++] ?? responses[responses.length - 1]!
    return new Response(typeof resp.body === "string" ? resp.body : JSON.stringify(resp.body), {
      status: resp.status,
      headers: resp.headers,
    })
  }) as unknown as typeof fetch
}

function makeCtx(overrides: Partial<OcrProviderContext> = {}): OcrProviderContext {
  return {
    credentials: overrides.credentials ?? { secrets: { applicationId: "id", password: "secret" } },
    config: overrides.config ?? { pollIntervalMs: 0, maxPolls: 5 },
    platform: "web",
    signal: overrides.signal,
  }
}

const input: OcrInput = {
  source: { kind: "data-url", dataUrl: "data:image/png;base64,YWJj", mimeType: "image/png" },
  languages: ["en"],
}

describe("buildAbbyyCloudProvider", () => {
  it("declares metadata + credential keys", () => {
    const p = buildAbbyyCloudProvider()
    expect(p.id).toBe("abbyy-cloud")
    expect(p.credentialKeys).toEqual(["applicationId", "password"])
  })
})

describe("abbyyCloudExtract — success", () => {
  it("submits to /v2/processImage, polls /v2/getTaskStatus, and downloads the first resultUrls entry", async () => {
    const urls: string[] = []
    let call = 0
    const responses = [
      JSON.stringify({ taskId: "t1", status: "InProgress", resultUrls: [] }),
      JSON.stringify({
        taskId: "t1",
        status: "Completed",
        resultUrls: ["https://cdn/abc.txt", "https://cdn/abc.xml"],
      }),
      "Hello world",
    ]
    const fetchImpl = jest.fn(async (url: RequestInfo | URL) => {
      urls.push(String(url))
      return new Response(responses[call++]!, { status: 200 })
    }) as unknown as typeof fetch
    const result = await abbyyCloudExtract(input, makeCtx(), fetchImpl)
    expect(result.pages[0]!.text).toBe("Hello world")
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(urls[0]).toContain("/v2/processImage?")
    expect(urls[1]).toContain("/v2/getTaskStatus?taskId=t1")
    // First entry of resultUrls is the configured single exportFormat.
    expect(urls[2]).toBe("https://cdn/abc.txt")
  })

  it("falls back to the v1 XML task envelope (custom endpoint pointing at a v1 server)", async () => {
    const fetchImpl = makeFetchSequence([
      {
        status: 200,
        body: '<response><task id="t1" status="Completed" resultUrl="https://cdn/r" /></response>',
      },
      { status: 200, body: "ok" },
    ])
    const result = await abbyyCloudExtract(
      input,
      makeCtx({
        config: { pollIntervalMs: 0, maxPolls: 5, endpoint: "https://legacy.example.com" },
      }),
      fetchImpl
    )
    expect(result.pages[0]!.text).toBe("ok")
  })

  it("sends Basic auth header", async () => {
    let seen: Headers | undefined
    const fetchImpl = jest.fn(async (_url, init: RequestInit | undefined) => {
      seen = seen ?? new Headers(init?.headers)
      const body =
        seen.get("authorization")?.startsWith("Basic ") && !seen.has("done")
          ? JSON.stringify({ taskId: "t1", status: "Completed", resultUrls: ["https://cdn/x"] })
          : "ok"
      seen.set("done", "true")
      return new Response(body, { status: 200 })
    }) as unknown as typeof fetch
    await abbyyCloudExtract(input, makeCtx(), fetchImpl)
    expect(seen?.get("authorization")?.startsWith("Basic ")).toBe(true)
  })
})

describe("abbyyCloudExtract — error paths", () => {
  it("throws missing_credentials when password is missing", async () => {
    const fetchImpl = makeFetchSequence([{ status: 200, body: {} }])
    await expect(
      abbyyCloudExtract(
        input,
        makeCtx({ credentials: { secrets: { applicationId: "x" } } }),
        fetchImpl
      )
    ).rejects.toMatchObject({ code: "missing_credentials" })
  })

  it("throws provider_failed on ProcessingFailed status", async () => {
    const fetchImpl = makeFetchSequence([
      { status: 200, body: { taskId: "t1", status: "ProcessingFailed", error: "bad" } },
    ])
    await expect(abbyyCloudExtract(input, makeCtx(), fetchImpl)).rejects.toMatchObject({
      code: "provider_failed",
    })
  })

  it("throws provider_failed on NotEnoughCredits", async () => {
    const fetchImpl = makeFetchSequence([
      { status: 200, body: { taskId: "t1", status: "NotEnoughCredits" } },
    ])
    await expect(abbyyCloudExtract(input, makeCtx(), fetchImpl)).rejects.toMatchObject({
      code: "provider_failed",
    })
  })

  it("fails fast on Deleted status instead of exhausting the poll budget", async () => {
    const fetchImpl = makeFetchSequence([
      { status: 200, body: { taskId: "t1", status: "Deleted" } },
    ])
    await expect(abbyyCloudExtract(input, makeCtx(), fetchImpl)).rejects.toMatchObject({
      code: "provider_failed",
      message: expect.stringContaining("Deleted"),
    })
    // One submit call only — the terminal status must not trigger any polls.
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it("throws provider_failed when polling never converges", async () => {
    const fetchImpl = makeFetchSequence([
      { status: 200, body: { taskId: "t1", status: "InProgress" } },
    ])
    await expect(
      abbyyCloudExtract(input, makeCtx({ config: { pollIntervalMs: 0, maxPolls: 2 } }), fetchImpl)
    ).rejects.toMatchObject({ code: "provider_failed" })
  })

  it("throws provider_failed when the task payload is unparseable", async () => {
    const fetchImpl = makeFetchSequence([{ status: 200, body: "garbage" }])
    await expect(abbyyCloudExtract(input, makeCtx(), fetchImpl)).rejects.toMatchObject({
      code: "provider_failed",
    })
  })

  it("maps HTTP 401 from submit to missing_credentials", async () => {
    const fetchImpl = makeFetchSequence([{ status: 401, body: "unauthorized" }])
    await expect(abbyyCloudExtract(input, makeCtx(), fetchImpl)).rejects.toMatchObject({
      code: "missing_credentials",
    })
  })
})
