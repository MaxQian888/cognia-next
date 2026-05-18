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
  it("submits, polls, and downloads the result text", async () => {
    const fetchImpl = makeFetchSequence([
      { status: 200, body: { id: "t1", status: "InProgress" } },
      { status: 200, body: { id: "t1", status: "Completed", resultUrl: "https://cdn/abc.txt" } },
      { status: 200, body: "Hello world" },
    ])
    const result = await abbyyCloudExtract(input, makeCtx(), fetchImpl)
    expect(result.pages[0]!.text).toBe("Hello world")
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it("parses an XML task response", async () => {
    const fetchImpl = makeFetchSequence([
      {
        status: 200,
        body: '<response><task id="t1" status="Completed" resultUrl="https://cdn/r" /></response>',
      },
      { status: 200, body: "ok" },
    ])
    const result = await abbyyCloudExtract(input, makeCtx(), fetchImpl)
    expect(result.pages[0]!.text).toBe("ok")
  })

  it("sends Basic auth header", async () => {
    let seen: Headers | undefined
    const fetchImpl = jest.fn(async (_url, init: RequestInit | undefined) => {
      seen = seen ?? new Headers(init?.headers)
      const body =
        seen.get("authorization")?.startsWith("Basic ") && !seen.has("done")
          ? JSON.stringify({ id: "t1", status: "Completed", resultUrl: "https://cdn/x" })
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
      { status: 200, body: { id: "t1", status: "ProcessingFailed", error: "bad" } },
    ])
    await expect(abbyyCloudExtract(input, makeCtx(), fetchImpl)).rejects.toMatchObject({
      code: "provider_failed",
    })
  })

  it("throws provider_failed on NotEnoughCredits", async () => {
    const fetchImpl = makeFetchSequence([
      { status: 200, body: { id: "t1", status: "NotEnoughCredits" } },
    ])
    await expect(abbyyCloudExtract(input, makeCtx(), fetchImpl)).rejects.toMatchObject({
      code: "provider_failed",
    })
  })

  it("throws provider_failed when polling never converges", async () => {
    const fetchImpl = makeFetchSequence([{ status: 200, body: { id: "t1", status: "InProgress" } }])
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
