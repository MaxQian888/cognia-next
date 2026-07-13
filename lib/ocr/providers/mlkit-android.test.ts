import {
  __setMlkitAndroidPluginLoader,
  buildMlkitAndroidProvider,
  mapMlKitBlock,
  MLKIT_PLUGIN_PACKAGE,
  mlkitAndroidExtract,
  type MlKitTextRecognitionPluginShape,
} from "./mlkit-android"
import type { OcrInput, OcrProviderContext } from "@/types/ocr"

const input: OcrInput = {
  source: { kind: "data-url", dataUrl: "data:image/png;base64,YWJj", mimeType: "image/png" },
  languages: ["zh"],
}

afterEach(() => __setMlkitAndroidPluginLoader(null))

describe("buildMlkitAndroidProvider", () => {
  it("declares Capacitor-only metadata", () => {
    const p = buildMlkitAndroidProvider()
    expect(p.shells).toEqual({ browser: false, tauri: false, capacitor: true })
  })
})

describe("mapMlKitBlock", () => {
  it("converts the plugin's left/top/right/bottom boundingBox to x/y/width/height", () => {
    expect(
      mapMlKitBlock({
        text: "你好",
        boundingBox: { left: 10, top: 20, right: 110, bottom: 60 },
        recognizedLanguage: "zh",
      })
    ).toEqual({
      text: "你好",
      bbox: { x: 10, y: 20, width: 100, height: 40 },
      kind: "paragraph",
    })
  })

  it("leaves bbox undefined when the plugin reports no boundingBox", () => {
    expect(mapMlKitBlock({ text: "plain", boundingBox: null })).toEqual({
      text: "plain",
      bbox: undefined,
      kind: "paragraph",
    })
  })
})

describe("mlkitAndroidExtract", () => {
  function plugin(): MlKitTextRecognitionPluginShape {
    return {
      detectText: jest.fn(async () => ({
        text: "你好",
        blocks: [{ text: "你好", boundingBox: { left: 0, top: 0, right: 10, bottom: 5 } }],
      })),
    }
  }

  it("calls detectText with the base64Image payload (upstream v8 API)", async () => {
    const p = plugin()
    const ctx: OcrProviderContext = {
      credentials: { secrets: {} },
      config: { pluginLoader: async () => p },
      platform: "mobile",
    }
    const result = await mlkitAndroidExtract(input, ctx)
    expect(p.detectText).toHaveBeenCalledWith({ base64Image: expect.any(String) })
    expect(result.pages[0]!.text).toBe("你好")
    expect(result.pages[0]!.blocks?.[0]?.bbox).toEqual({ x: 0, y: 0, width: 10, height: 5 })
  })

  it("throws unsupported_shell when running outside mobile", async () => {
    const ctx: OcrProviderContext = {
      credentials: { secrets: {} },
      config: {},
      platform: "tauri",
    }
    await expect(mlkitAndroidExtract(input, ctx)).rejects.toMatchObject({
      code: "unsupported_shell",
    })
  })

  it("surfaces a failing plugin import as unsupported_shell naming the missing package", async () => {
    const ctx: OcrProviderContext = {
      credentials: { secrets: {} },
      config: {
        pluginLoader: async () => {
          throw new Error("Cannot find module")
        },
      },
      platform: "mobile",
    }
    await expect(mlkitAndroidExtract(input, ctx)).rejects.toMatchObject({
      code: "unsupported_shell",
      message: expect.stringContaining(MLKIT_PLUGIN_PACKAGE),
    })
  })

  it("wraps plugin runtime errors into provider_failed", async () => {
    const p: MlKitTextRecognitionPluginShape = {
      detectText: jest.fn(async () => {
        throw new Error("recognize panic")
      }),
    }
    const ctx: OcrProviderContext = {
      credentials: { secrets: {} },
      config: { pluginLoader: async () => p },
      platform: "mobile",
    }
    await expect(mlkitAndroidExtract(input, ctx)).rejects.toMatchObject({
      code: "provider_failed",
    })
  })

  it("uses module-level loader as a default", async () => {
    const p: MlKitTextRecognitionPluginShape = {
      detectText: jest.fn(async () => ({ text: "ok", blocks: [] })),
    }
    __setMlkitAndroidPluginLoader(async () => p)
    const ctx: OcrProviderContext = {
      credentials: { secrets: {} },
      config: {},
      platform: "mobile",
    }
    await mlkitAndroidExtract(input, ctx)
    expect(p.detectText).toHaveBeenCalledTimes(1)
  })
})
