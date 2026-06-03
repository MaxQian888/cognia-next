import {
  __setNativeOcrInvoker,
  buildTesseractNativeProvider,
  tesseractNativeExtract,
} from "./tesseract-native"
import type { OcrInput, OcrProviderContext } from "@/types/ocr"

const input: OcrInput = {
  source: { kind: "data-url", dataUrl: "data:image/png;base64,YWJj", mimeType: "image/png" },
  languages: ["en"],
}

afterEach(() => __setNativeOcrInvoker(null))

describe("buildTesseractNativeProvider", () => {
  it("declares Tauri-only shell support", () => {
    const p = buildTesseractNativeProvider()
    expect(p.id).toBe("tesseract-native")
    expect(p.shells).toEqual({ browser: false, tauri: true, capacitor: false })
    expect(p.category).toBe("local")
  })
})

describe("tesseractNativeExtract", () => {
  it("calls the invoker with the tesseract backend tag and returns blocks", async () => {
    const invoker = jest.fn(async () => ({
      text: "Hello",
      blocks: [
        {
          text: "Hello",
          bbox: { x: 0, y: 0, width: 10, height: 5 },
          confidence: 0.9,
        },
      ],
      width: 200,
      height: 50,
    }))
    const ctx: OcrProviderContext = {
      credentials: { secrets: {} },
      config: { invoker },
      platform: "tauri",
    }
    const result = await tesseractNativeExtract(input, ctx)
    expect(invoker).toHaveBeenCalledWith(
      expect.objectContaining({ backend: "tesseract", mimeType: "image/png", languages: ["en"] })
    )
    expect(result.pages[0]!.text).toBe("Hello")
    expect(result.pages[0]!.blocks?.[0]?.confidence).toBe(0.9)
    expect(result.pages[0]!.width).toBe(200)
  })

  it("throws unsupported_shell when no invoker is registered", async () => {
    const ctx: OcrProviderContext = {
      credentials: { secrets: {} },
      config: {},
      platform: "web",
    }
    await expect(tesseractNativeExtract(input, ctx)).rejects.toMatchObject({
      code: "unsupported_shell",
    })
  })

  it("uses the module-level invoker when ctx.config.invoker is missing", async () => {
    const invoker = jest.fn(async () => ({ text: "ok", blocks: [] }))
    __setNativeOcrInvoker(invoker)
    const ctx: OcrProviderContext = {
      credentials: { secrets: {} },
      config: {},
      platform: "tauri",
    }
    await tesseractNativeExtract(input, ctx)
    expect(invoker).toHaveBeenCalledTimes(1)
  })

  it("wraps invoker exceptions into provider_failed", async () => {
    const invoker = jest.fn(async () => {
      throw new Error("native binding panicked")
    })
    const ctx: OcrProviderContext = {
      credentials: { secrets: {} },
      config: { invoker },
      platform: "tauri",
    }
    await expect(tesseractNativeExtract(input, ctx)).rejects.toMatchObject({
      code: "provider_failed",
    })
  })
})
