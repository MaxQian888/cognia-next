import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { __resetSharedOcrRegistry, getSharedOcrRegistry } from "./registry"
import { __resetOcrRuntime, installOcrRuntime } from "./runtime"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  __resetSharedOcrRegistry()
  __resetOcrRuntime()
})

afterEach(() => {
  __resetSharedOcrRegistry()
  __resetOcrRuntime()
})

describe("installOcrRuntime", () => {
  it("registers all 17 OCR providers in the shared registry", async () => {
    await installOcrRuntime()
    const registry = getSharedOcrRegistry()
    const ids = registry.list().map((p) => p.id)
    expect(ids).toEqual(
      expect.arrayContaining([
        "mistral-ocr",
        "google-vision",
        "aws-textract",
        "azure-document-intelligence",
        "anthropic-vision",
        "openai-vision",
        "gemini-vision",
        "mathpix",
        "ocr-space",
        "abbyy-cloud",
        "nanonets",
        "lark-basic",
        "tesseract-wasm",
        "tesseract-native",
        "windows-media-ocr",
        "apple-vision",
        "mlkit-android",
      ])
    )
    expect(registry.list()).toHaveLength(17)
  })

  it("is idempotent — calling twice is a no-op", async () => {
    await installOcrRuntime()
    await installOcrRuntime()
    expect(getSharedOcrRegistry().list()).toHaveLength(17)
  })

  it("accepts a caller-supplied native invoker (used for tests)", async () => {
    const invoker = jest.fn(async () => ({ text: "", blocks: [] }))
    await installOcrRuntime({ nativeInvoker: invoker })
    // The injected invoker is registered against all three platform-native
    // providers; we verify the tesseract-native module-level state was set
    // by running an extraction through it.
    const tesseract = getSharedOcrRegistry().get("tesseract-native")!
    const result = await tesseract.extract(
      {
        source: {
          kind: "data-url",
          dataUrl: "data:image/png;base64,YWJj",
          mimeType: "image/png",
        },
      },
      {
        credentials: { secrets: {} },
        config: {},
        platform: "tauri",
      }
    )
    expect(invoker).toHaveBeenCalled()
    expect(result.providerId).toBe("tesseract-native")
  })

  it("accepts a windows readiness probe override", async () => {
    const probe = jest.fn(async () => false)
    const invoker = jest.fn(async () => ({ text: "", blocks: [] }))
    await installOcrRuntime({ nativeInvoker: invoker, windowsReadinessProbe: probe })
    const windows = getSharedOcrRegistry().get("windows-media-ocr")!
    await expect(
      windows.extract(
        {
          source: {
            kind: "data-url",
            dataUrl: "data:image/png;base64,YWJj",
            mimeType: "image/png",
          },
        },
        { credentials: { secrets: {} }, config: {}, platform: "tauri" }
      )
    ).rejects.toMatchObject({ code: "unsupported_shell" })
    expect(probe).toHaveBeenCalled()
  })
})
