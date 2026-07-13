import {
  __setTesseractRecognizerFactory,
  buildTesseractWasmProvider,
  tesseractWasmExtract,
  type TesseractRecognizer,
  type TesseractRecognizeResult,
} from "./tesseract-wasm"
import type { OcrInput, OcrProviderContext } from "@/types/ocr"

function mockRecognizer(data: TesseractRecognizeResult): TesseractRecognizer {
  return {
    recognize: jest.fn(async () => data),
    terminate: jest.fn(async () => {}),
  }
}

afterEach(() => {
  __setTesseractRecognizerFactory(null)
})

const input: OcrInput = {
  source: { kind: "data-url", dataUrl: "data:image/png;base64,YWJj", mimeType: "image/png" },
  languages: ["en"],
}

describe("buildTesseractWasmProvider", () => {
  it("declares local-category metadata across every shell", () => {
    const p = buildTesseractWasmProvider()
    expect(p.id).toBe("tesseract-wasm")
    expect(p.category).toBe("local")
    expect(p.credentialKeys).toEqual([])
    expect(p.shells).toEqual({ browser: true, tauri: true, capacitor: true })
  })
})

describe("tesseractWasmExtract", () => {
  it("returns text + paragraph bbox blocks from the v7 blocks tree", async () => {
    const recognizer = mockRecognizer({
      data: {
        text: "Hello world",
        confidence: 92,
        blocks: [
          {
            text: "Hello world",
            confidence: 90,
            bbox: { x0: 0, y0: 0, x1: 20, y1: 20 },
            paragraphs: [
              {
                text: "Hello world",
                confidence: 92,
                bbox: { x0: 1, y0: 2, x1: 10, y1: 8 },
              },
            ],
          },
        ],
      },
    })
    const ctx: OcrProviderContext = {
      credentials: { secrets: {} },
      config: { recognizer },
      platform: "web",
    }
    const result = await tesseractWasmExtract(input, ctx)
    expect(result.pages[0]!.text).toBe("Hello world")
    expect(result.pages[0]!.blocks?.[0]?.bbox).toEqual({ x: 1, y: 2, width: 9, height: 6 })
    expect(result.pages[0]!.blocks?.[0]?.confidence).toBeCloseTo(0.92)
    expect(result.providerId).toBe("tesseract-wasm")
  })

  it("requests the blocks output format and passes the image as a Blob", async () => {
    const recognizer = mockRecognizer({ data: { text: "" } })
    const ctx: OcrProviderContext = {
      credentials: { secrets: {} },
      config: { recognizer },
      platform: "web",
    }
    await tesseractWasmExtract(input, ctx)
    // recognize(image, options, output) — language is NOT an argument (it is
    // fixed at createWorker time); block structure must be opted into.
    expect(recognizer.recognize).toHaveBeenCalledWith(
      expect.any(Blob),
      {},
      { text: true, blocks: true }
    )
  })

  it("falls back to block-level text when a block has no paragraph tree", async () => {
    const recognizer = mockRecognizer({
      data: {
        text: "Orphan",
        blocks: [{ text: "Orphan", confidence: 50, bbox: { x0: 0, y0: 0, x1: 4, y1: 2 } }],
      },
    })
    const ctx: OcrProviderContext = {
      credentials: { secrets: {} },
      config: { recognizer },
      platform: "web",
    }
    const result = await tesseractWasmExtract(input, ctx)
    expect(result.pages[0]!.blocks).toEqual([
      {
        text: "Orphan",
        bbox: { x: 0, y: 0, width: 4, height: 2 },
        confidence: 0.5,
        kind: "paragraph",
      },
    ])
  })

  it("returns zero blocks when data.blocks is null (output not requested)", async () => {
    const recognizer = mockRecognizer({ data: { text: "plain", blocks: null } })
    const ctx: OcrProviderContext = {
      credentials: { secrets: {} },
      config: { recognizer },
      platform: "web",
    }
    const result = await tesseractWasmExtract(input, ctx)
    expect(result.pages[0]!.blocks).toEqual([])
    expect(result.pages[0]!.text).toBe("plain")
  })

  it("maps en -> eng, zh -> chi_sim into the factory language list", async () => {
    const recognizer = mockRecognizer({ data: { text: "" } })
    const factory = jest.fn(async () => recognizer)
    __setTesseractRecognizerFactory(factory)
    const ctx: OcrProviderContext = {
      credentials: { secrets: {} },
      config: {},
      platform: "web",
    }
    await tesseractWasmExtract({ ...input, languages: ["zh", "EN"] }, ctx)
    expect(factory).toHaveBeenCalledWith(["chi_sim", "eng"], {
      workerPath: undefined,
      corePath: undefined,
      langPath: undefined,
    })
  })

  it("forwards workerPath/corePath/langPath config overrides to the factory", async () => {
    const recognizer = mockRecognizer({ data: { text: "" } })
    const factory = jest.fn(async () => recognizer)
    __setTesseractRecognizerFactory(factory)
    const ctx: OcrProviderContext = {
      credentials: { secrets: {} },
      config: {
        workerPath: "/custom/worker.min.js",
        corePath: "/custom/core",
        langPath: "/custom/lang",
      },
      platform: "web",
    }
    await tesseractWasmExtract(input, ctx)
    expect(factory).toHaveBeenCalledWith(["eng"], {
      workerPath: "/custom/worker.min.js",
      corePath: "/custom/core",
      langPath: "/custom/lang",
    })
  })

  it("uses the injected factory and caches the recognizer across calls", async () => {
    const recognizer = mockRecognizer({ data: { text: "ok" } })
    const factory = jest.fn(async () => recognizer)
    __setTesseractRecognizerFactory(factory)
    const ctx: OcrProviderContext = {
      credentials: { secrets: {} },
      config: {},
      platform: "web",
    }
    await tesseractWasmExtract(input, ctx)
    await tesseractWasmExtract(input, ctx)
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it("re-creates the recognizer when the language changes", async () => {
    const recognizer = mockRecognizer({ data: { text: "ok" } })
    const factory = jest.fn(async () => recognizer)
    __setTesseractRecognizerFactory(factory)
    const ctx: OcrProviderContext = {
      credentials: { secrets: {} },
      config: {},
      platform: "web",
    }
    await tesseractWasmExtract({ ...input, languages: ["en"] }, ctx)
    await tesseractWasmExtract({ ...input, languages: ["zh"] }, ctx)
    expect(factory).toHaveBeenCalledTimes(2)
  })

  it("wraps factory failures into provider_failed", async () => {
    __setTesseractRecognizerFactory(async () => {
      throw new Error("wasm fetch failed")
    })
    const ctx: OcrProviderContext = {
      credentials: { secrets: {} },
      config: {},
      platform: "web",
    }
    await expect(tesseractWasmExtract(input, ctx)).rejects.toMatchObject({
      code: "provider_failed",
    })
  })

  it("wraps recognize() failures into provider_failed", async () => {
    const recognizer: TesseractRecognizer = {
      recognize: jest.fn(async () => {
        throw new Error("recognize boom")
      }),
    }
    const ctx: OcrProviderContext = {
      credentials: { secrets: {} },
      config: { recognizer },
      platform: "web",
    }
    await expect(tesseractWasmExtract(input, ctx)).rejects.toMatchObject({
      code: "provider_failed",
    })
  })
})
