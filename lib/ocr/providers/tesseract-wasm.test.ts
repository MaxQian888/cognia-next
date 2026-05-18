import {
  __setTesseractRecognizerFactory,
  buildTesseractWasmProvider,
  tesseractWasmExtract,
  type TesseractRecognizer,
} from "./tesseract-wasm"
import type { OcrInput, OcrProviderContext } from "../types"

function mockRecognizer(
  data: TesseractRecognizer["recognize"] extends infer T
    ? T extends (...args: infer _A) => Promise<infer R>
      ? R
      : never
    : never
): TesseractRecognizer {
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
  it("returns text + bbox blocks from the recognizer result", async () => {
    const recognizer = mockRecognizer({
      data: {
        text: "Hello world",
        confidence: 92,
        paragraphs: [
          {
            text: "Hello world",
            confidence: 92,
            bbox: { x0: 1, y0: 2, x1: 10, y1: 8 },
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

  it("maps en -> eng, zh -> chi_sim in the language argument", async () => {
    const recognizer = mockRecognizer({ data: { text: "" } })
    const ctx: OcrProviderContext = {
      credentials: { secrets: {} },
      config: { recognizer },
      platform: "web",
    }
    await tesseractWasmExtract({ ...input, languages: ["zh", "EN"] }, ctx)
    expect(recognizer.recognize).toHaveBeenCalledWith(expect.any(Uint8Array), "chi_sim+eng")
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
