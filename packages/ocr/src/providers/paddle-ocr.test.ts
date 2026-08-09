import {
  __setPaddleOcrInvoker,
  __setPaddleOcrReadiness,
  buildPaddleOcrProvider,
  paddleOcrExtract,
} from "./paddle-ocr"
import { __setNativeOcrInvoker, type NativeOcrInvoker } from "./tesseract-native"
import type { OcrInput, OcrProviderContext } from "../types"

const input: OcrInput = {
  source: { kind: "data-url", dataUrl: "data:image/png;base64,YWJj", mimeType: "image/png" },
  languages: ["zh-cn", "en"],
}

afterEach(() => {
  __setPaddleOcrInvoker(null)
  __setPaddleOcrReadiness(null)
  __setNativeOcrInvoker(null)
})

describe("buildPaddleOcrProvider", () => {
  it("declares a Tauri-only local provider", () => {
    const p = buildPaddleOcrProvider()
    expect(p.id).toBe("paddle-ocr")
    expect(p.category).toBe("local")
    expect(p.shells).toEqual({ browser: false, tauri: true, capacitor: false })
    expect(p.credentialKeys).toEqual([])
  })
})

describe("paddleOcrExtract", () => {
  it("dispatches to the invoker with the paddle-ocr backend tag", async () => {
    const invoker = jest.fn(async () => ({
      text: "你好 world",
      blocks: [
        {
          text: "你好 world",
          bbox: { x: 0, y: 0, width: 120, height: 24 },
          confidence: 0.93,
        },
      ],
      width: 480,
      height: 64,
    }))
    const ctx: OcrProviderContext = {
      credentials: { secrets: {} },
      config: { invoker },
      platform: "tauri",
    }
    const result = await paddleOcrExtract(input, ctx)
    expect(invoker).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: "paddle-ocr",
        mimeType: "image/png",
        languages: ["zh-cn", "en"],
      })
    )
    expect(result.providerId).toBe("paddle-ocr")
    expect(result.pages[0]!.text).toBe("你好 world")
    expect(result.pages[0]!.blocks?.[0]?.confidence).toBeCloseTo(0.93)
  })

  it("sends no options field — the invoke payload has no model knob", async () => {
    const invoker = jest.fn<ReturnType<NativeOcrInvoker>, Parameters<NativeOcrInvoker>>(
      async () => ({ text: "ok", blocks: [] })
    )
    const ctx: OcrProviderContext = {
      credentials: { secrets: {} },
      config: { invoker },
      platform: "tauri",
    }
    await paddleOcrExtract(input, ctx)
    expect(invoker.mock.calls[0]![0]).not.toHaveProperty("options")
  })

  it("maps a MissingBinding rejection to unsupported_shell", async () => {
    const invoker = jest.fn(async () => {
      throw new Error("OCR backend `paddle-ocr` is not bound on this platform")
    })
    const ctx: OcrProviderContext = {
      credentials: { secrets: {} },
      config: { invoker },
      platform: "tauri",
    }
    await expect(paddleOcrExtract(input, ctx)).rejects.toMatchObject({
      code: "unsupported_shell",
      providerId: "paddle-ocr",
    })
  })

  it("defaults languages to zh-cn + en when caller omits them", async () => {
    const invoker = jest.fn(async () => ({ text: "ok", blocks: [] }))
    const ctx: OcrProviderContext = {
      credentials: { secrets: {} },
      config: { invoker },
      platform: "tauri",
    }
    const noLang: OcrInput = {
      source: input.source,
    }
    await paddleOcrExtract(noLang, ctx)
    expect(invoker).toHaveBeenCalledWith(expect.objectContaining({ languages: ["zh-cn", "en"] }))
  })

  it("uses the module-level invoker when ctx.config.invoker is missing", async () => {
    const invoker = jest.fn(async () => ({ text: "ok", blocks: [] }))
    __setPaddleOcrInvoker(invoker)
    const ctx: OcrProviderContext = {
      credentials: { secrets: {} },
      config: {},
      platform: "tauri",
    }
    await paddleOcrExtract(input, ctx)
    expect(invoker).toHaveBeenCalledTimes(1)
  })

  it("throws unsupported_shell when no invoker is registered", async () => {
    const ctx: OcrProviderContext = {
      credentials: { secrets: {} },
      config: {},
      platform: "tauri",
    }
    await expect(paddleOcrExtract(input, ctx)).rejects.toMatchObject({
      code: "unsupported_shell",
      providerId: "paddle-ocr",
    })
  })

  it("throws unsupported_shell when readiness probe returns false", async () => {
    const invoker = jest.fn(async () => ({ text: "ok", blocks: [] }))
    const ctx: OcrProviderContext = {
      credentials: { secrets: {} },
      config: { invoker, isReady: async () => false },
      platform: "tauri",
    }
    await expect(paddleOcrExtract(input, ctx)).rejects.toMatchObject({
      code: "unsupported_shell",
    })
    expect(invoker).not.toHaveBeenCalled()
  })

  it("checks readiness for the same model variant it invokes", async () => {
    const invoker = jest.fn(async () => ({ text: "ok", blocks: [] }))
    const isReady = jest.fn(async () => true)
    const ctx: OcrProviderContext = {
      credentials: { secrets: {} },
      config: { invoker, isReady, model: "v6-tiny" },
      platform: "tauri",
    }

    await paddleOcrExtract(input, ctx)

    expect(isReady).toHaveBeenCalledWith("v6-tiny")
    expect(invoker).toHaveBeenCalledWith(expect.objectContaining({ modelVariant: "v6-tiny" }))
  })

  it("wraps invoker exceptions into provider_failed", async () => {
    const invoker = jest.fn(async () => {
      throw new Error("ort binary missing")
    })
    const ctx: OcrProviderContext = {
      credentials: { secrets: {} },
      config: { invoker },
      platform: "tauri",
    }
    await expect(paddleOcrExtract(input, ctx)).rejects.toMatchObject({
      code: "provider_failed",
      providerId: "paddle-ocr",
    })
  })
})
