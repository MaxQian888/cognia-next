/** @jest-environment jsdom */
import { createNullOcrCache, createNullOcrPageCache } from "@/lib/ocr/cache-contract"
import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import {
  defaultDepsBuilder,
  ocrPluginDefinition,
  runOcrTool,
  TOOL_PARAMETERS,
  type OcrToolInput,
} from "./index"
import { createOcrRegistry, getSharedOcrRegistry } from "@/lib/ocr/registry"
import { DEFAULT_OCR_SETTINGS, type OcrProvider, type OcrResult } from "@/types/ocr"

function makeProvider(): OcrProvider {
  return {
    id: "mock",
    label: "Mock",
    category: "document-cloud",
    shells: { browser: true, tauri: true, capacitor: true },
    credentialKeys: [],
    async extract(): Promise<OcrResult> {
      return {
        providerId: "mock",
        pages: [{ pageNumber: 1, markdown: "# Hello", text: "Hello" }],
        combinedMarkdown: "# Hello",
        combinedText: "Hello",
        languages: [],
        durationMs: 0,
        cached: false,
      }
    },
  }
}

function makeDeps() {
  const registry = createOcrRegistry()
  registry.register(makeProvider())
  return {
    registry,
    settings: { ...DEFAULT_OCR_SETTINGS, defaultProviderId: "mock" },
    platform: "web" as const,
    credentialsResolver: async () => ({ secrets: {} }),
    cache: createNullOcrCache(),
    pageCache: createNullOcrPageCache(),
  }
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

describe("ocrPluginDefinition", () => {
  it("declares the cognia-ocr manifest", () => {
    expect(ocrPluginDefinition.manifest).toMatchObject({
      id: "cognia-ocr",
      name: "OCR",
      capabilities: expect.arrayContaining(["tools", "commands"]),
    })
  })

  it("registers the ocr.extract tool when activated", async () => {
    const registerTool = jest.fn()
    await ocrPluginDefinition.activate({
      pluginId: "cognia-ocr",
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      agent: { registerTool },
    } as unknown as Parameters<typeof ocrPluginDefinition.activate>[0])
    expect(registerTool).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "ocr.extract",
        pluginId: "cognia-ocr",
      })
    )
  })
})

describe("runOcrTool", () => {
  const baseInput: OcrToolInput = {
    source: { kind: "data_url", value: "data:image/png;base64,YWJj" },
    languages: ["en"],
  }

  it("returns { ok: true, result } on success", async () => {
    const out = await runOcrTool(baseInput, { buildDeps: makeDeps })
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.result.providerId).toBe("mock")
      expect(out.result.pages[0]!.markdown).toContain("Hello")
    }
  })

  it("supports attachment_id sources with the snake_case shape", async () => {
    const attachmentResolver = jest.fn(async () => ({
      blob: new Blob([new Uint8Array([1, 2, 3])]),
      mimeType: "image/png",
    }))
    const deps = { ...makeDeps(), attachmentResolver }
    const out = await runOcrTool(
      { source: { kind: "attachment_id", value: "att_1" } },
      { buildDeps: () => deps }
    )
    expect(out.ok).toBe(true)
    expect(attachmentResolver).toHaveBeenCalledWith("att_1")
  })

  it("threads the provider override to extract", async () => {
    const registry = createOcrRegistry()
    registry.register({ ...makeProvider(), id: "explicit" })
    const out = await runOcrTool(
      { ...baseInput, provider: "explicit" },
      {
        buildDeps: () => ({
          registry,
          settings: { ...DEFAULT_OCR_SETTINGS },
          platform: "web",
          credentialsResolver: async () => ({ secrets: {} }),
          cache: createNullOcrCache(),
          pageCache: createNullOcrPageCache(),
        }),
      }
    )
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.result.providerId).toBe("explicit")
  })

  it("rejects unknown source kinds", async () => {
    const out = await runOcrTool(
      // @ts-expect-error — exercising the runtime guard
      { source: { kind: "magic", value: "x" } },
      { buildDeps: makeDeps }
    )
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error).toMatch(/Unknown source kind/)
  })

  it("returns ok:false with code when extract throws", async () => {
    const registry = createOcrRegistry()
    registry.register({
      ...makeProvider(),
      id: "boom",
      async extract() {
        const { OcrError } = await import("@/lib/ocr/errors")
        throw new OcrError("rate_limited", "boom", "slow")
      },
    })
    const out = await runOcrTool(
      { source: { kind: "data_url", value: "data:image/png;base64,YWJj" } },
      {
        buildDeps: () => ({
          registry,
          settings: { ...DEFAULT_OCR_SETTINGS, defaultProviderId: "boom" },
          platform: "web",
          credentialsResolver: async () => ({ secrets: {} }),
          cache: createNullOcrCache(),
          pageCache: createNullOcrPageCache(),
        }),
      }
    )
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.code).toBe("rate_limited")
  })

  it("reports runtime-not-ready when no deps are available", async () => {
    const out = await runOcrTool(baseInput, { buildDeps: () => null })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error).toMatch(/runtime is not ready/i)
  })

  it("screen mode captures + OCRs via the injected captureScreen", async () => {
    const captureScreen = jest.fn(async () => ({
      providerId: "windows-media-ocr",
      pages: [{ pageNumber: 1, markdown: "SCREEN", text: "SCREEN" }],
      combinedMarkdown: "SCREEN",
      combinedText: "SCREEN",
      languages: ["en"],
      durationMs: 1,
      cached: false,
    }))
    const out = await runOcrTool(
      { source: { kind: "screen" }, languages: ["en"] },
      { captureScreen }
    )
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.result.combinedText).toBe("SCREEN")
    expect(captureScreen).toHaveBeenCalledWith(["en"])
  })

  it("screen mode surfaces a capture failure as ok:false", async () => {
    const captureScreen = jest.fn(async () => {
      throw new Error("automation disabled")
    })
    const out = await runOcrTool({ source: { kind: "screen" } }, { captureScreen })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error).toMatch(/automation disabled/)
  })
})

describe("file-path source wiring", () => {
  // `buildOcrDeps` leaves `filePathResolver` undefined unless a caller supplies
  // one, and the plugin supplied nothing — so `/ocr <path>` (the usage string
  // the slash command itself prints) threw
  // "file-path source requires a filePathResolver" 100% of the time.
  it("supplies a filePathResolver to the extract deps", async () => {
    const registry = getSharedOcrRegistry()
    registry.register(makeProvider())
    const deps = await defaultDepsBuilder()
    expect(deps).not.toBeNull()
    expect(typeof deps?.filePathResolver).toBe("function")
  })

  it("does not advertise a source kind nothing can resolve", () => {
    // `attachment_id` has no producer anywhere in the app, so offering it to
    // the model only ever yields a guaranteed resolver error.
    const kinds = (
      TOOL_PARAMETERS as unknown as {
        properties: { source: { properties: { kind: { enum: string[] } } } }
      }
    ).properties.source.properties.kind.enum
    expect([...kinds]).toEqual(["data_url", "file_path", "screen"])
  })
})
