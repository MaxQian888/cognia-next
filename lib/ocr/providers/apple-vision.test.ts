import {
  __setAppleVisionPluginLoader,
  __setAppleVisionTauriInvoker,
  appleVisionExtract,
  buildAppleVisionProvider,
  type AppleVisionPluginShape,
} from "./apple-vision"
import type { OcrInput, OcrProviderContext } from "@/types/ocr"

const input: OcrInput = {
  source: { kind: "data-url", dataUrl: "data:image/png;base64,YWJj", mimeType: "image/png" },
  languages: ["en"],
}

afterEach(() => {
  __setAppleVisionTauriInvoker(null)
  __setAppleVisionPluginLoader(null)
})

describe("buildAppleVisionProvider", () => {
  it("declares Tauri + Capacitor shell support", () => {
    const p = buildAppleVisionProvider()
    expect(p.shells).toEqual({ browser: false, tauri: true, capacitor: true })
  })
})

describe("appleVisionExtract — tauri path", () => {
  it("delegates to the apple-vision native backend", async () => {
    const invoker = jest.fn(async () => ({
      text: "Hola",
      blocks: [{ text: "Hola", bbox: { x: 0, y: 0, width: 10, height: 5 } }],
    }))
    const ctx: OcrProviderContext = {
      credentials: { secrets: {} },
      config: { invoker },
      platform: "tauri",
    }
    const result = await appleVisionExtract(input, ctx)
    expect(invoker).toHaveBeenCalledWith(expect.objectContaining({ backend: "apple-vision" }))
    expect(result.pages[0]!.text).toBe("Hola")
    expect(result.pages[0]!.blocks?.[0]?.bbox).toEqual({ x: 0, y: 0, width: 10, height: 5 })
  })

  it("throws unsupported_shell when no Tauri invoker is registered", async () => {
    const ctx: OcrProviderContext = {
      credentials: { secrets: {} },
      config: {},
      platform: "tauri",
    }
    await expect(appleVisionExtract(input, ctx)).rejects.toMatchObject({
      code: "unsupported_shell",
    })
  })

  it("wraps Tauri invoker errors into provider_failed", async () => {
    const invoker = jest.fn(async () => {
      throw new Error("Swift sidecar exited")
    })
    const ctx: OcrProviderContext = {
      credentials: { secrets: {} },
      config: { invoker },
      platform: "tauri",
    }
    await expect(appleVisionExtract(input, ctx)).rejects.toMatchObject({
      code: "provider_failed",
    })
  })
})

describe("appleVisionExtract — mobile path", () => {
  function buildPlugin(): AppleVisionPluginShape {
    return {
      recognizeText: jest.fn(async () => ({
        text: "iOS",
        blocks: [{ text: "iOS", confidence: 0.99 }],
      })),
    }
  }

  it("calls the Capacitor plugin on the mobile shell", async () => {
    const plugin = buildPlugin()
    const ctx: OcrProviderContext = {
      credentials: { secrets: {} },
      config: { pluginLoader: async () => plugin },
      platform: "mobile",
    }
    const result = await appleVisionExtract(input, ctx)
    expect(plugin.recognizeText).toHaveBeenCalled()
    expect(result.pages[0]!.text).toBe("iOS")
    expect(result.pages[0]!.blocks?.[0]?.confidence).toBe(0.99)
  })

  it("maps a missing plugin to unsupported_shell", async () => {
    const ctx: OcrProviderContext = {
      credentials: { secrets: {} },
      config: {
        pluginLoader: async () => {
          throw new Error("not installed")
        },
      },
      platform: "mobile",
    }
    await expect(appleVisionExtract(input, ctx)).rejects.toMatchObject({
      code: "unsupported_shell",
    })
  })

  it("maps plugin throw to provider_failed", async () => {
    const plugin: AppleVisionPluginShape = {
      recognizeText: jest.fn(async () => {
        throw new Error("plugin boom")
      }),
    }
    const ctx: OcrProviderContext = {
      credentials: { secrets: {} },
      config: { pluginLoader: async () => plugin },
      platform: "mobile",
    }
    await expect(appleVisionExtract(input, ctx)).rejects.toMatchObject({
      code: "provider_failed",
    })
  })
})

describe("appleVisionExtract — invalid shell", () => {
  it("rejects with unsupported_shell on the web shell", async () => {
    const ctx: OcrProviderContext = {
      credentials: { secrets: {} },
      config: {},
      platform: "web",
    }
    await expect(appleVisionExtract(input, ctx)).rejects.toMatchObject({
      code: "unsupported_shell",
    })
  })
})
