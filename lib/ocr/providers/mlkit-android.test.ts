import {
  __setMlkitAndroidPluginLoader,
  buildMlkitAndroidProvider,
  defaultScriptFor,
  mlkitAndroidExtract,
  type MlkitAndroidPluginShape,
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

describe("defaultScriptFor", () => {
  it.each([
    ["en", "latin"],
    ["fr-CA", "latin"],
    ["zh", "chinese"],
    ["ja", "japanese"],
    ["ko", "korean"],
    ["hi", "devanagari"],
    ["unknown", "latin"],
  ] as const)("maps %s to %s", (bcp, expected) => {
    expect(defaultScriptFor(bcp)).toBe(expected)
  })
})

describe("mlkitAndroidExtract", () => {
  function plugin(): MlkitAndroidPluginShape {
    return {
      recognizeText: jest.fn(async () => ({
        text: "你好",
        blocks: [{ text: "你好", confidence: 0.9 }],
      })),
    }
  }

  it("calls the plugin with the resolved script for the first language", async () => {
    const p = plugin()
    const ctx: OcrProviderContext = {
      credentials: { secrets: {} },
      config: { pluginLoader: async () => p },
      platform: "mobile",
    }
    const result = await mlkitAndroidExtract(input, ctx)
    expect(p.recognizeText).toHaveBeenCalledWith(expect.objectContaining({ script: "chinese" }))
    expect(result.pages[0]!.text).toBe("你好")
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

  it("treats plugin import failure as unsupported_shell", async () => {
    const ctx: OcrProviderContext = {
      credentials: { secrets: {} },
      config: {
        pluginLoader: async () => {
          throw new Error("not installed")
        },
      },
      platform: "mobile",
    }
    await expect(mlkitAndroidExtract(input, ctx)).rejects.toMatchObject({
      code: "unsupported_shell",
    })
  })

  it("wraps plugin runtime errors into provider_failed", async () => {
    const p: MlkitAndroidPluginShape = {
      recognizeText: jest.fn(async () => {
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
    const p: MlkitAndroidPluginShape = {
      recognizeText: jest.fn(async () => ({ text: "ok", blocks: [] })),
    }
    __setMlkitAndroidPluginLoader(async () => p)
    const ctx: OcrProviderContext = {
      credentials: { secrets: {} },
      config: {},
      platform: "mobile",
    }
    await mlkitAndroidExtract(input, ctx)
    expect(p.recognizeText).toHaveBeenCalledTimes(1)
  })

  it("supports a caller-supplied scriptFor override", async () => {
    const p: MlkitAndroidPluginShape = {
      recognizeText: jest.fn(async () => ({ text: "ok", blocks: [] })),
    }
    const ctx: OcrProviderContext = {
      credentials: { secrets: {} },
      config: { pluginLoader: async () => p, scriptFor: () => "korean" },
      platform: "mobile",
    }
    await mlkitAndroidExtract(input, ctx)
    expect(p.recognizeText).toHaveBeenCalledWith(expect.objectContaining({ script: "korean" }))
  })
})
