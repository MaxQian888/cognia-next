jest.mock("@/lib/tauri", () => {
  const actual = jest.requireActual("@/lib/tauri")
  return { ...actual, transport: { ...actual.transport, call: jest.fn() } }
})

import { createDbTestFixture } from "@/lib/db/test-fixture"
import { transport } from "@/lib/tauri"
import { __resetSharedOcrRegistry, getSharedOcrRegistry } from "./registry"
import { __resetOcrRuntime, installOcrRuntime } from "./runtime"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  __resetSharedOcrRegistry()
  __resetOcrRuntime()
  delete (globalThis as Record<string, unknown>).__COGNIA_HEADLESS__
  ;(transport.call as jest.Mock).mockReset()
})

afterEach(() => {
  __resetSharedOcrRegistry()
  __resetOcrRuntime()
  delete (globalThis as Record<string, unknown>).__COGNIA_HEADLESS__
})

afterAll(dbFixture.dispose)

describe("installOcrRuntime", () => {
  it("registers all 20 OCR providers in the shared registry", async () => {
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
        "ocrs",
        "paddle-ocr",
        "local-http",
      ])
    )
    expect(registry.list()).toHaveLength(20)
  })

  it("is idempotent — calling twice is a no-op", async () => {
    await installOcrRuntime()
    await installOcrRuntime()
    expect(getSharedOcrRegistry().list()).toHaveLength(20)
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

  it("routes native extraction through the headless service transport", async () => {
    ;(globalThis as Record<string, unknown>).__COGNIA_HEADLESS__ = true
    ;(transport.call as jest.Mock).mockResolvedValue({ text: "server text", blocks: [] })
    await installOcrRuntime()
    const tesseract = getSharedOcrRegistry().get("tesseract-native")!
    const result = await tesseract.extract(
      {
        source: {
          kind: "data-url",
          dataUrl: "data:image/png;base64,YWJj",
          mimeType: "image/png",
        },
      },
      { credentials: { secrets: {} }, config: {}, platform: "headless" }
    )
    expect(result.pages[0]?.text).toBe("server text")
    expect(transport.call).toHaveBeenCalledWith(
      "ocr_extract_native",
      expect.objectContaining({
        payload: expect.objectContaining({ backend: "tesseract", mime_type: "image/png" }),
      })
    )
  })

  it("surfaces the Rust MissingBinding rejection as unsupported_shell so the router falls through", async () => {
    // The PlaceholderBackend registered when a Cargo OCR feature is off
    // rejects `ocr_extract_native` with this exact message shape
    // (crates/cognia-ocr/src/native.rs `NativeOcrError::MissingBinding`).
    const invoker = jest.fn(async () => {
      throw new Error("OCR backend `tesseract` is not bound on this platform")
    })
    await installOcrRuntime({ nativeInvoker: invoker })
    const tesseract = getSharedOcrRegistry().get("tesseract-native")!
    await expect(
      tesseract.extract(
        {
          source: {
            kind: "data-url",
            dataUrl: "data:image/png;base64,YWJj",
            mimeType: "image/png",
          },
        },
        { credentials: { secrets: {} }, config: {}, platform: "tauri" }
      )
    ).rejects.toMatchObject({
      code: "unsupported_shell",
      message: "This build does not include the tesseract native binding.",
    })
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

  it("routes the shared invoker to ocrs and paddle-ocr providers", async () => {
    const invoker = jest.fn(async () => ({ text: "hello", blocks: [] }))
    await installOcrRuntime({
      nativeInvoker: invoker,
      modelReadinessProbe: async () => true,
    })
    const ocrs = getSharedOcrRegistry().get("ocrs")!
    const result = await ocrs.extract(
      {
        source: {
          kind: "data-url",
          dataUrl: "data:image/png;base64,YWJj",
          mimeType: "image/png",
        },
      },
      { credentials: { secrets: {} }, config: {}, platform: "tauri" }
    )
    expect(invoker).toHaveBeenCalledWith(expect.objectContaining({ backend: "ocrs" }))
    expect(result.providerId).toBe("ocrs")
  })

  it("gates ocrs and paddle-ocr on the selected model variant", async () => {
    const probe = jest.fn(async (_b: "ocrs" | "paddle-ocr", _variant?: string) => false)
    const invoker = jest.fn(async () => ({ text: "", blocks: [] }))
    await installOcrRuntime({
      nativeInvoker: invoker,
      modelReadinessProbe: probe,
    })
    const ocrs = getSharedOcrRegistry().get("ocrs")!
    await expect(
      ocrs.extract(
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
    expect(probe).toHaveBeenCalledWith("ocrs")
    expect(invoker).not.toHaveBeenCalled()

    const paddle = getSharedOcrRegistry().get("paddle-ocr")!
    await expect(
      paddle.extract(
        {
          source: {
            kind: "data-url",
            dataUrl: "data:image/png;base64,YWJj",
            mimeType: "image/png",
          },
        },
        {
          credentials: { secrets: {} },
          config: { model: "v6-tiny" },
          platform: "tauri",
        }
      )
    ).rejects.toMatchObject({ code: "unsupported_shell" })
    expect(probe).toHaveBeenCalledWith("paddle-ocr", "v6-tiny")
  })

  it("wires the packaged local HTTP transport into the provider", async () => {
    const localHttpTransport = {
      request: jest.fn(async (request: { method: string }) => ({
        status: 200,
        body: JSON.stringify(request.method === "GET" ? {} : { code: 100, data: "host" }),
        contentType: "application/json",
      })),
      cancel: jest.fn(async () => false),
    }
    await installOcrRuntime({ localHttpTransport })

    const provider = getSharedOcrRegistry().get("local-http")!
    const result = await provider.extract(
      {
        source: {
          kind: "data-url",
          dataUrl: "data:image/png;base64,YWJj",
          mimeType: "image/png",
        },
      },
      {
        credentials: { secrets: {} },
        config: { endpoint: "http://localhost:1224/api/ocr" },
        platform: "tauri",
      }
    )

    expect(result.pages[0]?.text).toBe("host")
    expect(localHttpTransport.request).toHaveBeenCalledWith(
      expect.objectContaining({ url: "http://localhost:1224/api/ocr", method: "POST" })
    )
  })
})
