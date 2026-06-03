const screenshotMock = jest.fn()
const extractMock = jest.fn()
jest.mock("./client", () => ({
  desktop: { screenshot: (...a: unknown[]) => screenshotMock(...a) },
}))
jest.mock("@/lib/ocr", () => ({ extract: (...a: unknown[]) => extractMock(...a) }))
jest.mock("@/lib/ocr/deps", () => ({ buildOcrDeps: () => ({ marker: "deps" }) }))

import { ocrScreen, ocrScreenWith, type OcrScreenDeps } from "./ocr-screen"
import type { OcrResult } from "@/types/ocr"

function ocrResult(text: string): OcrResult {
  return {
    providerId: "windows-media-ocr",
    pages: [{ pageNumber: 1, markdown: text, text }],
    combinedMarkdown: text,
    combinedText: text,
    languages: ["en"],
    durationMs: 1,
    cached: false,
  }
}

function deps(over: Partial<OcrScreenDeps> = {}): OcrScreenDeps {
  return {
    screenshot: jest.fn(async () => ({ bytes: "QUJD", format: "png" as const })),
    extract: jest.fn(async () => ocrResult("SCREEN TEXT")),
    ocrDeps: {} as OcrScreenDeps["ocrDeps"],
    ...over,
  }
}

describe("ocrScreenWith", () => {
  it("captures then OCRs the screen as a png data-url", async () => {
    const extract = jest.fn(async () => ocrResult("HELLO SCREEN"))
    const screenshot = jest.fn(async () => ({ bytes: "QUJD", format: "png" as const }))
    const out = await ocrScreenWith(deps({ extract, screenshot }), { languages: ["en", "zh"] })
    expect(out.combinedText).toBe("HELLO SCREEN")
    expect(screenshot).toHaveBeenCalledWith({}, { surface: "computerUse" })
    expect(extract).toHaveBeenCalledWith(
      {
        source: { kind: "data-url", dataUrl: "data:image/png;base64,QUJD", mimeType: "image/png" },
        languages: ["en", "zh"],
      },
      expect.anything()
    )
  })

  it("maps the jpeg screenshot format to image/jpeg", async () => {
    const extract = jest.fn(async () => ocrResult("X"))
    await ocrScreenWith(
      deps({ extract, screenshot: jest.fn(async () => ({ bytes: "ZZ", format: "jpeg" as const })) })
    )
    expect(extract).toHaveBeenCalledWith(
      expect.objectContaining({
        source: expect.objectContaining({ mimeType: "image/jpeg" }),
      }),
      expect.anything()
    )
  })

  it("passes through a custom screenshot opts + ctx", async () => {
    const screenshot = jest.fn(async () => ({ bytes: "QUJD", format: "png" as const }))
    await ocrScreenWith(deps({ screenshot }), {
      opts: { region: { x: 0, y: 0, width: 10, height: 10 } } as never,
      ctx: { surface: "plugin", pluginId: "cognia-ocr" },
    })
    expect(screenshot).toHaveBeenCalledWith(
      { region: { x: 0, y: 0, width: 10, height: 10 } },
      { surface: "plugin", pluginId: "cognia-ocr" }
    )
  })
})

describe("ocrScreen (production entry)", () => {
  beforeEach(() => {
    screenshotMock.mockReset().mockResolvedValue({ bytes: "QUJD", format: "png" })
    extractMock.mockReset().mockResolvedValue(ocrResult("PROD SCREEN"))
  })

  it("composes the real screenshot client + extract pipeline", async () => {
    const out = await ocrScreen({ languages: ["en"] })
    expect(out.combinedText).toBe("PROD SCREEN")
    expect(screenshotMock).toHaveBeenCalledWith({}, { surface: "computerUse" })
    expect(extractMock).toHaveBeenCalledTimes(1)
  })
})
