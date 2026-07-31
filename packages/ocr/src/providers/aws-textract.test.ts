import { awsTextractExtract, buildAwsTextractProvider } from "./aws-textract"
import type { OcrProviderContext } from "../types"

function makeFetch(resp: { status: number; body: unknown }) {
  return jest.fn(async () => {
    return new Response(typeof resp.body === "string" ? resp.body : JSON.stringify(resp.body), {
      status: resp.status,
    })
  }) as unknown as typeof fetch
}

function makeCtx(overrides: Partial<OcrProviderContext> = {}): OcrProviderContext {
  return {
    credentials: overrides.credentials ?? {
      secrets: { accessKeyId: "AKIA", secretAccessKey: "secret" },
    },
    config: overrides.config ?? { now: new Date("2024-01-15T12:00:00Z") },
    platform: overrides.platform ?? "tauri",
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

describe("buildAwsTextractProvider", () => {
  it("declares the right metadata", () => {
    const p = buildAwsTextractProvider()
    expect(p.id).toBe("aws-textract")
    expect(p.credentialKeys).toContain("accessKeyId")
    expect(p.credentialKeys).toContain("secretAccessKey")
  })
})

describe("awsTextractExtract — success", () => {
  it("parses LINE blocks into per-page text and bboxes", async () => {
    const fetchImpl = makeFetch({
      status: 200,
      body: {
        DocumentMetadata: { Pages: 1 },
        Blocks: [
          { BlockType: "PAGE" },
          {
            BlockType: "LINE",
            Page: 1,
            Text: "Hello world",
            Confidence: 99.5,
            Geometry: {
              BoundingBox: { Left: 0.1, Top: 0.2, Width: 0.3, Height: 0.05 },
            },
          },
          {
            BlockType: "LINE",
            Page: 1,
            Text: "Second line",
            Confidence: 88,
            Geometry: { BoundingBox: { Left: 0.1, Top: 0.3, Width: 0.4, Height: 0.05 } },
          },
        ],
      },
    })
    const result = await awsTextractExtract(input, makeCtx(), fetchImpl)
    expect(result.pages).toHaveLength(1)
    expect(result.pages[0]!.text).toBe("Hello world\nSecond line")
    expect(result.pages[0]!.blocks).toHaveLength(2)
    expect(result.pages[0]!.blocks?.[0]?.confidence).toBeCloseTo(0.995)
    expect(result.pages[0]!.blocks?.[0]?.bbox).toEqual({
      x: 0.1,
      y: 0.2,
      width: 0.3,
      height: 0.05,
    })
  })

  it("sends DetectDocumentText when tables/forms are disabled", async () => {
    let seenHeaders: Headers | undefined
    const fetchImpl = jest.fn(async (_url, init: RequestInit | undefined) => {
      seenHeaders = new Headers(init?.headers)
      return new Response(JSON.stringify({ DocumentMetadata: { Pages: 1 }, Blocks: [] }), {
        status: 200,
      })
    }) as unknown as typeof fetch
    await awsTextractExtract(
      input,
      makeCtx({ config: { enableTables: false, now: new Date(0) } }),
      fetchImpl
    )
    expect(seenHeaders?.get("x-amz-target")).toBe("Textract.DetectDocumentText")
  })

  it("sends AnalyzeDocument with TABLES/FORMS when configured", async () => {
    let seenHeaders: Headers | undefined
    let seenBody = ""
    const fetchImpl = jest.fn(async (_url, init: RequestInit | undefined) => {
      seenHeaders = new Headers(init?.headers)
      seenBody = (init?.body as string) ?? ""
      return new Response(JSON.stringify({ DocumentMetadata: { Pages: 1 }, Blocks: [] }), {
        status: 200,
      })
    }) as unknown as typeof fetch
    await awsTextractExtract(
      input,
      makeCtx({ config: { enableTables: true, enableForms: true, now: new Date(0) } }),
      fetchImpl
    )
    expect(seenHeaders?.get("x-amz-target")).toBe("Textract.AnalyzeDocument")
    expect(seenBody).toContain("TABLES")
    expect(seenBody).toContain("FORMS")
  })

  it("creates an empty page array when DocumentMetadata reports more pages than blocks", async () => {
    const fetchImpl = makeFetch({
      status: 200,
      body: { DocumentMetadata: { Pages: 2 }, Blocks: [] },
    })
    const result = await awsTextractExtract(input, makeCtx(), fetchImpl)
    expect(result.pages).toHaveLength(2)
    expect(result.pages[1]!.text).toBe("")
  })
})

describe("awsTextractExtract — error paths", () => {
  it("throws missing_credentials without access keys", async () => {
    const fetchImpl = makeFetch({ status: 200, body: { Blocks: [] } })
    await expect(
      awsTextractExtract(input, makeCtx({ credentials: { secrets: {} } }), fetchImpl)
    ).rejects.toMatchObject({ code: "missing_credentials" })
  })

  it("throws invalid_input for PDF sources", async () => {
    const fetchImpl = makeFetch({ status: 200, body: { Blocks: [] } })
    await expect(
      awsTextractExtract(
        {
          source: {
            kind: "data-url",
            dataUrl: "data:application/pdf;base64,JVBERi0x",
            mimeType: "application/pdf",
          },
        },
        makeCtx(),
        fetchImpl
      )
    ).rejects.toMatchObject({ code: "invalid_input" })
  })

  it("throws invalid_input before uploading when the document exceeds 10 MB", async () => {
    const fetchImpl = jest.fn() as unknown as typeof fetch
    const bigInput = {
      source: {
        kind: "blob" as const,
        blob: new Blob([new Uint8Array(10 * 1024 * 1024 + 1)]),
        mimeType: "image/png",
      },
    }
    await expect(awsTextractExtract(bigInput, makeCtx(), fetchImpl)).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("10 MB"),
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("accepts a document of exactly 10 MB", async () => {
    const fetchImpl = makeFetch({
      status: 200,
      body: { DocumentMetadata: { Pages: 1 }, Blocks: [] },
    })
    const maxInput = {
      source: {
        kind: "blob" as const,
        blob: new Blob([new Uint8Array(10 * 1024 * 1024)]),
        mimeType: "image/png",
      },
    }
    const result = await awsTextractExtract(maxInput, makeCtx(), fetchImpl)
    expect(result.pages).toHaveLength(1)
  })

  // AWS always signals exceptions via non-2xx statuses with the real kind in
  // the body's `__type` — the HTTP status alone is often misleading.
  it.each([
    ["ThrottlingException", 500, "rate_limited"],
    ["ProvisionedThroughputExceededException", 400, "rate_limited"],
    ["LimitExceededException", 400, "rate_limited"],
    ["AccessDeniedException", 400, "missing_credentials"],
    ["UnrecognizedClientException", 403, "missing_credentials"],
    ["InvalidSignatureException", 403, "missing_credentials"],
    ["ExpiredTokenException", 400, "missing_credentials"],
    ["UnsupportedDocumentException", 400, "invalid_input"],
    ["DocumentTooLargeException", 400, "invalid_input"],
    ["BadDocumentException", 400, "invalid_input"],
    ["InvalidParameterException", 400, "invalid_input"],
  ] as const)("maps %s (HTTP %i) to %s", async (type, status, code) => {
    const fetchImpl = makeFetch({ status, body: { __type: type, Message: "err" } })
    await expect(awsTextractExtract(input, makeCtx(), fetchImpl)).rejects.toMatchObject({ code })
  })

  it("strips the com.amazonaws.textract# namespace prefix from __type", async () => {
    const fetchImpl = makeFetch({
      status: 500,
      body: { __type: "com.amazonaws.textract#ThrottlingException", Message: "slow down" },
    })
    await expect(awsTextractExtract(input, makeCtx(), fetchImpl)).rejects.toMatchObject({
      code: "rate_limited",
    })
  })

  it("falls back to status mapping for an unknown __type", async () => {
    const fetchImpl = makeFetch({
      status: 400,
      body: { __type: "SomeNewException", Message: "?" },
    })
    await expect(awsTextractExtract(input, makeCtx(), fetchImpl)).rejects.toMatchObject({
      code: "invalid_input",
    })
  })

  it("falls back to status mapping when the error body is not JSON", async () => {
    const fetchImpl = makeFetch({ status: 500, body: "boom" })
    await expect(awsTextractExtract(input, makeCtx(), fetchImpl)).rejects.toMatchObject({
      code: "provider_failed",
    })
  })

  it("maps HTTP 403 without a body to missing_credentials", async () => {
    const fetchImpl = makeFetch({ status: 403, body: "" })
    await expect(awsTextractExtract(input, makeCtx(), fetchImpl)).rejects.toMatchObject({
      code: "missing_credentials",
    })
  })
})
