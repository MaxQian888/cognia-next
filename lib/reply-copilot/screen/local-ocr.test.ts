jest.mock("@/lib/ocr", () => ({ extract: jest.fn() }))
jest.mock("@/lib/ocr/deps", () => ({ buildOcrDeps: jest.fn() }))
jest.mock("@/lib/ocr/user-settings", () => ({ loadUserOcrSettings: jest.fn() }))

import type { Screenshot } from "@/lib/automation/types"
import type { ExtractDeps } from "@/lib/ocr"
import type { OcrInput, OcrProvider, OcrResult } from "@/types/ocr"
import { LocalOcrUnavailableError, readWindowText, type LocalOcrDeps } from "./local-ocr"

const shot: Screenshot = {
  bytes: "AAAA",
  width: 400,
  height: 300,
  capturedAt: 0,
  format: "png",
  sourceWidth: 800,
  sourceHeight: 600,
}

function provider(id: string, category: OcrProvider["category"]): OcrProvider {
  return { id, label: id, category, shells: {}, credentialKeys: [], extract: jest.fn() } as never
}

const result: OcrResult = {
  providerId: "apple-vision",
  pages: [
    {
      pageNumber: 1,
      markdown: "",
      text: "",
      width: 400,
      height: 300,
      blocks: [
        { text: "在吗", bbox: { x: 10, y: 20, width: 50, height: 10 } },
        { text: "no geometry" },
      ],
    },
  ],
  combinedMarkdown: "",
  combinedText: "",
  languages: [],
  durationMs: 1,
  cached: false,
}

function deps(candidates: OcrProvider[]) {
  const extract = jest.fn(async (_input: OcrInput, _deps: ExtractDeps) => result)
  const d: LocalOcrDeps = {
    ocrDeps: async () => ({}) as ExtractDeps,
    candidates: async () => candidates,
    extract,
  }
  return { d, extract }
}

describe("readWindowText", () => {
  it("uses the first local engine explicitly, uncached, and maps lines to frame pixels", async () => {
    const { d, extract } = deps([
      provider("google-vision", "document-cloud"),
      provider("apple-vision", "local"),
    ])
    const text = await readWindowText(shot, undefined, d)
    const [input] = extract.mock.calls[0]
    expect(input.providerId).toBe("apple-vision")
    expect(input.useCache).toBe(false)
    expect(input.source).toEqual({
      kind: "data-url",
      dataUrl: "data:image/png;base64,AAAA",
      mimeType: "image/png",
    })
    // The capture was downscaled 2x; lines come back in source pixels.
    expect(text).toEqual({
      providerId: "apple-vision",
      lines: [{ text: "在吗", bbox: { x: 20, y: 40, width: 100, height: 20 } }],
    })
  })

  it("refuses to fall back to a cloud engine", async () => {
    const { d, extract } = deps([provider("google-vision", "document-cloud")])
    await expect(readWindowText(shot, undefined, d)).rejects.toBeInstanceOf(
      LocalOcrUnavailableError
    )
    expect(extract).not.toHaveBeenCalled()
  })

  it("stops before OCR when aborted", async () => {
    const { d, extract } = deps([provider("apple-vision", "local")])
    const controller = new AbortController()
    controller.abort()
    await expect(readWindowText(shot, controller.signal, d)).rejects.toThrow()
    expect(extract).not.toHaveBeenCalled()
  })
})
