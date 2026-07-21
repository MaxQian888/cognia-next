import { __setOcrsInvoker, __setOcrsReadiness, buildOcrsProvider, ocrsExtract } from "./ocrs"
import { __setNativeOcrInvoker } from "./tesseract-native"
import type { OcrInput, OcrProviderContext } from "../types"

const input: OcrInput = {
  source: { kind: "data-url", dataUrl: "data:image/png;base64,YWJj", mimeType: "image/png" },
  languages: ["en"],
}

afterEach(() => {
  __setOcrsInvoker(null)
  __setOcrsReadiness(null)
  __setNativeOcrInvoker(null)
})

describe("buildOcrsProvider", () => {
  it("declares a Tauri-only local provider", () => {
    const p = buildOcrsProvider()
    expect(p.id).toBe("ocrs")
    expect(p.category).toBe("local")
    expect(p.shells).toEqual({ browser: false, tauri: true, capacitor: false })
    expect(p.credentialKeys).toEqual([])
  })
})

describe("ocrsExtract", () => {
  it("dispatches to the invoker with the ocrs backend tag", async () => {
    const invoker = jest.fn(async () => ({
      text: "Hello world",
      blocks: [{ text: "Hello world", bbox: { x: 0, y: 0, width: 100, height: 20 } }],
      width: 320,
      height: 240,
    }))
    const ctx: OcrProviderContext = {
      credentials: { secrets: {} },
      config: { invoker },
      platform: "tauri",
    }
    const result = await ocrsExtract(input, ctx)
    expect(invoker).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: "ocrs",
        mimeType: "image/png",
        languages: ["en"],
      })
    )
    expect(result.providerId).toBe("ocrs")
    expect(result.pages[0]!.text).toBe("Hello world")
    expect(result.pages[0]!.blocks?.[0]?.kind).toBe("line")
    expect(result.pages[0]!.width).toBe(320)
  })

  it("uses the module-level invoker when config.invoker is missing", async () => {
    const invoker = jest.fn(async () => ({ text: "ok", blocks: [] }))
    __setOcrsInvoker(invoker)
    const ctx: OcrProviderContext = {
      credentials: { secrets: {} },
      config: {},
      platform: "tauri",
    }
    await ocrsExtract(input, ctx)
    expect(invoker).toHaveBeenCalledTimes(1)
  })

  it("throws unsupported_shell when no invoker is registered", async () => {
    const ctx: OcrProviderContext = {
      credentials: { secrets: {} },
      config: {},
      platform: "tauri",
    }
    await expect(ocrsExtract(input, ctx)).rejects.toMatchObject({
      code: "unsupported_shell",
      providerId: "ocrs",
    })
  })

  it("throws unsupported_shell when readiness probe returns false", async () => {
    const invoker = jest.fn(async () => ({ text: "ok", blocks: [] }))
    const ctx: OcrProviderContext = {
      credentials: { secrets: {} },
      config: { invoker, isReady: () => false },
      platform: "tauri",
    }
    await expect(ocrsExtract(input, ctx)).rejects.toMatchObject({
      code: "unsupported_shell",
      providerId: "ocrs",
    })
    expect(invoker).not.toHaveBeenCalled()
  })

  it("uses the module-level readiness probe when ctx.config omits it", async () => {
    const invoker = jest.fn(async () => ({ text: "ok", blocks: [] }))
    __setOcrsInvoker(invoker)
    __setOcrsReadiness(async () => false)
    const ctx: OcrProviderContext = {
      credentials: { secrets: {} },
      config: {},
      platform: "tauri",
    }
    await expect(ocrsExtract(input, ctx)).rejects.toMatchObject({
      code: "unsupported_shell",
    })
    expect(invoker).not.toHaveBeenCalled()
  })

  it("wraps invoker exceptions into provider_failed", async () => {
    const invoker = jest.fn(async () => {
      throw new Error("rten panicked")
    })
    const ctx: OcrProviderContext = {
      credentials: { secrets: {} },
      config: { invoker },
      platform: "tauri",
    }
    await expect(ocrsExtract(input, ctx)).rejects.toMatchObject({
      code: "provider_failed",
      providerId: "ocrs",
    })
  })

  it("maps a MissingBinding rejection to unsupported_shell", async () => {
    const invoker = jest.fn(async () => {
      throw new Error("OCR backend `ocrs` is not bound on this platform")
    })
    const ctx: OcrProviderContext = {
      credentials: { secrets: {} },
      config: { invoker },
      platform: "tauri",
    }
    await expect(ocrsExtract(input, ctx)).rejects.toMatchObject({
      code: "unsupported_shell",
      providerId: "ocrs",
    })
  })

  it("passes ocrs invoker through to the shared native invoker slot", async () => {
    // The shared invoker is mutated as a side-effect of __setOcrsInvoker so
    // every other Rust-backed provider can dispatch through the same Tauri
    // command. Verify by reading the shared slot via tesseract-native.
    const shared = jest.fn(async () => ({ text: "shared", blocks: [] }))
    __setOcrsInvoker(shared)
    // Now call tesseract-native — it should pick up the same invoker.
    const { tesseractNativeExtract } = await import("./tesseract-native")
    const ctx: OcrProviderContext = {
      credentials: { secrets: {} },
      config: {},
      platform: "tauri",
    }
    await tesseractNativeExtract(input, ctx)
    expect(shared).toHaveBeenCalledWith(expect.objectContaining({ backend: "tesseract" }))
  })

  it("normalizes language codes to lowercase before invoking", async () => {
    const invoker = jest.fn(async () => ({ text: "ok", blocks: [] }))
    const ctx: OcrProviderContext = {
      credentials: { secrets: {} },
      config: { invoker },
      platform: "tauri",
    }
    await ocrsExtract({ ...input, languages: ["EN", "ZH-CN"] }, ctx)
    expect(invoker).toHaveBeenCalledWith(expect.objectContaining({ languages: ["en", "zh-cn"] }))
  })
})
