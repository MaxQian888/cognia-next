import {
  __setWindowsMediaOcrInvoker,
  __setWindowsMediaOcrReadiness,
  buildWindowsMediaOcrProvider,
  windowsMediaOcrExtract,
} from "./windows-media-ocr"
import type { OcrInput, OcrProviderContext } from "../types"

const input: OcrInput = {
  source: { kind: "data-url", dataUrl: "data:image/png;base64,YWJj", mimeType: "image/png" },
  languages: ["en"],
}

afterEach(() => {
  __setWindowsMediaOcrInvoker(null)
  __setWindowsMediaOcrReadiness(null)
})

describe("buildWindowsMediaOcrProvider", () => {
  it("declares Tauri-only metadata", () => {
    const p = buildWindowsMediaOcrProvider()
    expect(p.id).toBe("windows-media-ocr")
    expect(p.shells).toEqual({ browser: false, tauri: true, capacitor: false })
  })
})

describe("windowsMediaOcrExtract", () => {
  it("calls the invoker with the windows-media-ocr backend tag", async () => {
    const invoker = jest.fn(async () => ({
      text: "Hello",
      blocks: [{ text: "Hello", confidence: 0.95 }],
    }))
    const ctx: OcrProviderContext = {
      credentials: { secrets: {} },
      config: { invoker, isReady: () => true },
      platform: "tauri",
    }
    const result = await windowsMediaOcrExtract(input, ctx)
    expect(invoker).toHaveBeenCalledWith(expect.objectContaining({ backend: "windows-media-ocr" }))
    expect(result.pages[0]!.text).toBe("Hello")
    expect(result.pages[0]!.blocks?.[0]?.confidence).toBe(0.95)
  })

  it("throws unsupported_shell when readiness probe returns false", async () => {
    const ctx: OcrProviderContext = {
      credentials: { secrets: {} },
      config: { invoker: jest.fn(), isReady: () => false },
      platform: "tauri",
    }
    await expect(windowsMediaOcrExtract(input, ctx)).rejects.toMatchObject({
      code: "unsupported_shell",
    })
  })

  it("throws unsupported_shell when no invoker is registered", async () => {
    const ctx: OcrProviderContext = {
      credentials: { secrets: {} },
      config: {},
      platform: "tauri",
    }
    await expect(windowsMediaOcrExtract(input, ctx)).rejects.toMatchObject({
      code: "unsupported_shell",
    })
  })

  it("maps the Rust MissingBinding rejection to unsupported_shell", async () => {
    const invoker = jest.fn(async () => {
      throw new Error("OCR backend `windows-media-ocr` is not bound on this platform")
    })
    const ctx: OcrProviderContext = {
      credentials: { secrets: {} },
      config: { invoker, isReady: () => true },
      platform: "tauri",
    }
    await expect(windowsMediaOcrExtract(input, ctx)).rejects.toMatchObject({
      code: "unsupported_shell",
      providerId: "windows-media-ocr",
      message: "This build does not include the windows-media-ocr native binding.",
    })
  })

  it("wraps invoker failures into provider_failed", async () => {
    const invoker = jest.fn(async () => {
      throw new Error("winocr panic")
    })
    const ctx: OcrProviderContext = {
      credentials: { secrets: {} },
      config: { invoker, isReady: () => true },
      platform: "tauri",
    }
    await expect(windowsMediaOcrExtract(input, ctx)).rejects.toMatchObject({
      code: "provider_failed",
    })
  })

  it("uses module-level invoker + readiness when config doesn't override", async () => {
    const invoker = jest.fn(async () => ({ text: "ok", blocks: [] }))
    __setWindowsMediaOcrInvoker(invoker)
    __setWindowsMediaOcrReadiness(() => true)
    const ctx: OcrProviderContext = {
      credentials: { secrets: {} },
      config: {},
      platform: "tauri",
    }
    await windowsMediaOcrExtract(input, ctx)
    expect(invoker).toHaveBeenCalledTimes(1)
  })
})
