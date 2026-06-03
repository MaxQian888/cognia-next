import {
  azureDocIntelExtract,
  buildAzureDocIntelligenceProvider,
} from "./azure-document-intelligence"
import type { OcrProviderContext } from "@/types/ocr"

function makeFetchSequence(
  responses: Array<{
    status: number
    body: unknown
    headers?: Record<string, string>
  }>
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
    credentials: overrides.credentials ?? {
      secrets: { apiKey: "key", endpoint: "https://demo.cognitiveservices.azure.com" },
    },
    config: overrides.config ?? { pollIntervalMs: 0, maxPolls: 5 },
    platform: overrides.platform ?? "web",
    signal: overrides.signal,
  }
}

const input = {
  source: {
    kind: "data-url" as const,
    dataUrl: "data:image/png;base64,YWJj",
    mimeType: "image/png",
  },
  languages: ["en"],
}

describe("buildAzureDocIntelligenceProvider", () => {
  it("declares the right metadata", () => {
    const p = buildAzureDocIntelligenceProvider()
    expect(p.id).toBe("azure-document-intelligence")
    expect(p.credentialKeys).toEqual(["apiKey", "endpoint"])
  })
})

describe("azureDocIntelExtract — success", () => {
  it("submits an analyze request and polls until succeeded", async () => {
    const fetchImpl = makeFetchSequence([
      {
        status: 202,
        body: "",
        headers: { "Operation-Location": "https://demo/op" },
      },
      { status: 200, body: { status: "running" } },
      {
        status: 200,
        body: {
          status: "succeeded",
          analyzeResult: {
            content: "Hello\nWorld",
            pages: [
              {
                pageNumber: 1,
                width: 8.5,
                height: 11,
                lines: [{ content: "Hello" }, { content: "World" }],
              },
            ],
            paragraphs: [
              {
                content: "Hello World",
                boundingRegions: [{ pageNumber: 1, polygon: [0, 0, 5, 0, 5, 1, 0, 1] }],
              },
            ],
          },
        },
      },
    ])
    const result = await azureDocIntelExtract(input, makeCtx(), fetchImpl)
    expect(result.providerId).toBe("azure-document-intelligence")
    expect(result.pages).toHaveLength(1)
    expect(result.pages[0]!.text).toBe("Hello\nWorld")
    expect(result.pages[0]!.markdown).toContain("Hello World")
    expect(result.pages[0]!.blocks).toHaveLength(1)
    expect(result.pages[0]!.blocks?.[0]?.bbox).toEqual({ x: 0, y: 0, width: 5, height: 1 })
  })

  it("falls back to synthesized page when pages array is missing", async () => {
    const fetchImpl = makeFetchSequence([
      { status: 202, body: "", headers: { "Operation-Location": "https://demo/op" } },
      { status: 200, body: { status: "succeeded", analyzeResult: { content: "just text" } } },
    ])
    const result = await azureDocIntelExtract(input, makeCtx(), fetchImpl)
    expect(result.pages).toHaveLength(1)
  })

  it("uses endpoint from credentials when not provided in config", async () => {
    let firstUrl = ""
    const fetchImpl = jest.fn(async (url: RequestInfo | URL) => {
      const u = typeof url === "string" ? url : url.toString()
      if (!firstUrl) firstUrl = u
      if (u.includes(":analyze")) {
        return new Response("", {
          status: 202,
          headers: { "Operation-Location": "https://demo/op" },
        })
      }
      return new Response(JSON.stringify({ status: "succeeded", analyzeResult: { pages: [] } }), {
        status: 200,
      })
    }) as unknown as typeof fetch
    await azureDocIntelExtract(input, makeCtx(), fetchImpl)
    expect(firstUrl).toContain("https://demo.cognitiveservices.azure.com/")
    expect(firstUrl).toContain("prebuilt-read")
  })

  it("uses config endpoint when both config and credentials provide one", async () => {
    let firstUrl = ""
    const fetchImpl = jest.fn(async (url: RequestInfo | URL) => {
      const u = typeof url === "string" ? url : url.toString()
      if (!firstUrl) firstUrl = u
      if (u.includes(":analyze")) {
        return new Response("", {
          status: 202,
          headers: { "Operation-Location": "https://demo/op" },
        })
      }
      return new Response(JSON.stringify({ status: "succeeded", analyzeResult: { pages: [] } }), {
        status: 200,
      })
    }) as unknown as typeof fetch
    await azureDocIntelExtract(
      input,
      makeCtx({
        config: {
          endpoint: "https://override.cognitiveservices.azure.com/",
          pollIntervalMs: 0,
          maxPolls: 5,
        },
      }),
      fetchImpl
    )
    expect(firstUrl).toContain("https://override.cognitiveservices.azure.com/")
  })
})

describe("azureDocIntelExtract — error paths", () => {
  it("throws missing_credentials when apiKey is absent", async () => {
    const fetchImpl = makeFetchSequence([{ status: 200, body: {} }])
    await expect(
      azureDocIntelExtract(input, makeCtx({ credentials: { secrets: {} } }), fetchImpl)
    ).rejects.toMatchObject({ code: "missing_credentials" })
  })

  it("throws missing_credentials when endpoint is absent", async () => {
    const fetchImpl = makeFetchSequence([{ status: 200, body: {} }])
    await expect(
      azureDocIntelExtract(input, makeCtx({ credentials: { secrets: { apiKey: "x" } } }), fetchImpl)
    ).rejects.toMatchObject({ code: "missing_credentials" })
  })

  it("throws provider_failed when the submit response omits Operation-Location", async () => {
    const fetchImpl = makeFetchSequence([{ status: 202, body: "" }])
    await expect(azureDocIntelExtract(input, makeCtx(), fetchImpl)).rejects.toMatchObject({
      code: "provider_failed",
    })
  })

  it("throws provider_failed when polling returns failed status", async () => {
    const fetchImpl = makeFetchSequence([
      { status: 202, body: "", headers: { "Operation-Location": "https://demo/op" } },
      {
        status: 200,
        body: { status: "failed", error: { code: "InvalidImage", message: "bad picture" } },
      },
    ])
    await expect(azureDocIntelExtract(input, makeCtx(), fetchImpl)).rejects.toMatchObject({
      code: "provider_failed",
    })
  })

  it("throws provider_failed when polling never converges", async () => {
    const fetchImpl = makeFetchSequence([
      { status: 202, body: "", headers: { "Operation-Location": "https://demo/op" } },
      { status: 200, body: { status: "running" } },
    ])
    await expect(
      azureDocIntelExtract(
        input,
        makeCtx({ config: { pollIntervalMs: 0, maxPolls: 2 } }),
        fetchImpl
      )
    ).rejects.toMatchObject({ code: "provider_failed" })
  })

  it("maps HTTP 401 from analyze submission to missing_credentials", async () => {
    const fetchImpl = makeFetchSequence([{ status: 401, body: "unauthorized" }])
    await expect(azureDocIntelExtract(input, makeCtx(), fetchImpl)).rejects.toMatchObject({
      code: "missing_credentials",
    })
  })

  it("maps HTTP 429 from analyze submission to rate_limited", async () => {
    const fetchImpl = makeFetchSequence([{ status: 429, body: "slow" }])
    await expect(azureDocIntelExtract(input, makeCtx(), fetchImpl)).rejects.toMatchObject({
      code: "rate_limited",
    })
  })

  it("aborts mid-poll when the signal is triggered", async () => {
    const controller = new AbortController()
    let polls = 0
    const fetchImpl = jest.fn(async () => {
      polls++
      if (polls === 1) {
        return new Response("", {
          status: 202,
          headers: { "Operation-Location": "https://demo/op" },
        })
      }
      controller.abort()
      return new Response(JSON.stringify({ status: "running" }), { status: 200 })
    }) as unknown as typeof fetch
    await expect(
      azureDocIntelExtract(input, makeCtx({ signal: controller.signal }), fetchImpl)
    ).rejects.toMatchObject({ code: "aborted" })
  })
})
