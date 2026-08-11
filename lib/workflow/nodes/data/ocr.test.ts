const extractMock = jest.fn()
const ocrScreenMock = jest.fn()
jest.mock("@/lib/ocr", () => ({ extract: (...a: unknown[]) => extractMock(...a) }))
jest.mock("@/lib/ocr/deps", () => ({ buildOcrDeps: () => ({ marker: "deps" }) }))
jest.mock("@/lib/automation/ocr-screen", () => ({
  ocrScreen: (...a: unknown[]) => ocrScreenMock(...a),
}))

import "./ocr"
import { resolveOcrNodeSource } from "./ocr"
import { getExecutor } from "../registry"
import type { StepExecutionContext } from "@/types/workflow/visual"
import type { OcrResult } from "@/types/ocr"

function result(text: string): OcrResult {
  return {
    providerId: "mistral-ocr",
    pages: [{ pageNumber: 1, markdown: text, text }],
    combinedMarkdown: `# ${text}`,
    combinedText: text,
    languages: ["en"],
    durationMs: 2,
    cached: false,
  }
}

function ctx(params: Record<string, unknown>): StepExecutionContext {
  return { runId: "r", workflowId: "w", stepId: "s", params } as StepExecutionContext
}

beforeEach(() => {
  extractMock.mockReset().mockResolvedValue(result("EXTRACTED"))
  ocrScreenMock.mockReset().mockResolvedValue(result("SCREEN"))
})

describe("resolveOcrNodeSource", () => {
  it("uses a data URL directly", async () => {
    const src = await resolveOcrNodeSource({ dataUrl: "data:image/jpeg;base64,QUJD" })
    expect(src).toEqual({
      kind: "data-url",
      dataUrl: "data:image/jpeg;base64,QUJD",
      mimeType: "image/jpeg",
    })
  })

  it("wraps raw base64 with the given mime (default png)", async () => {
    expect(await resolveOcrNodeSource({ imageBase64: "QUJD" })).toEqual({
      kind: "data-url",
      dataUrl: "data:image/png;base64,QUJD",
      mimeType: "image/png",
    })
    expect(
      await resolveOcrNodeSource({ imageBase64: "QUJD", mimeType: "image/webp" })
    ).toMatchObject({
      mimeType: "image/webp",
    })
  })

  it("fetches a URL into a blob source", async () => {
    const blob = new Blob(["x"], { type: "image/png" })
    globalThis.fetch = jest.fn(async () => ({ blob: async () => blob })) as unknown as typeof fetch
    const src = await resolveOcrNodeSource({ url: "https://x/y.png" })
    expect(src).toEqual({ kind: "blob", blob, mimeType: "image/png" })
  })

  it("throws when no source is provided", async () => {
    await expect(resolveOcrNodeSource({})).rejects.toThrow(/no image source/)
  })

  it("falls back to octet-stream for a malformed data URL", async () => {
    expect(await resolveOcrNodeSource({ dataUrl: "not-a-data-url" })).toEqual({
      kind: "data-url",
      dataUrl: "not-a-data-url",
      mimeType: "application/octet-stream",
    })
  })

  it("ignores blank/non-string source fields", async () => {
    await expect(
      resolveOcrNodeSource({ dataUrl: "", imageBase64: 42 as unknown as string })
    ).rejects.toThrow(/no image source/)
  })
})

describe("ocr.extract node executor", () => {
  it("is registered for typeVersion 1", () => {
    expect(getExecutor("ocr.extract", 1)).toBeDefined()
  })

  it("extracts from a data URL and shapes the output", async () => {
    const exec = getExecutor("ocr.extract", 1)!
    const out = await exec.execute(
      ctx({ dataUrl: "data:image/png;base64,QUJD", languages: ["en"] })
    )
    expect(out.output).toMatchObject({
      text: "EXTRACTED",
      markdown: "# EXTRACTED",
      providerId: "mistral-ocr",
      cached: false,
    })
    expect(extractMock).toHaveBeenCalledTimes(1)
  })

  it("routes screen mode through ocrScreen", async () => {
    const exec = getExecutor("ocr.extract", 1)!
    const out = await exec.execute(ctx({ screen: true, languages: ["zh"] }))
    expect(ocrScreenMock).toHaveBeenCalledWith({ languages: ["zh"] })
    expect(extractMock).not.toHaveBeenCalled()
    expect(out.output).toMatchObject({ text: "SCREEN" })
  })

  it("treats provider='auto' as no explicit provider and ignores non-array languages", async () => {
    const exec = getExecutor("ocr.extract", 1)!
    await exec.execute(
      ctx({
        dataUrl: "data:image/png;base64,QUJD",
        provider: "auto",
        format: "text",
        languages: "en",
      })
    )
    expect(extractMock).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: undefined, format: "text", languages: undefined }),
      expect.anything()
    )
  })

  it("passes an explicit provider through", async () => {
    const exec = getExecutor("ocr.extract", 1)!
    await exec.execute(ctx({ imageBase64: "QUJD", provider: "mistral-ocr" }))
    expect(extractMock).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: "mistral-ocr" }),
      expect.anything()
    )
  })
})
