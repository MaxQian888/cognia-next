import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { extract, type ExtractDeps } from "./index"
import { createOcrRegistry } from "./registry"
import {
  DEFAULT_OCR_SETTINGS,
  type OcrInput,
  type OcrProvider,
  type OcrResult,
  type UserOcrSettings,
} from "@/types/ocr"
import { OcrError } from "@/lib/ocr/errors"

function makeProvider(overrides: Partial<OcrProvider> & { onCall?: () => void } = {}): OcrProvider {
  return {
    id: overrides.id ?? "mock",
    label: overrides.label ?? "Mock",
    category: overrides.category ?? "document-cloud",
    shells: overrides.shells ?? { browser: true, tauri: true, capacitor: true },
    credentialKeys: overrides.credentialKeys ?? [],
    reusesMainProviderKey: overrides.reusesMainProviderKey,
    async extract(input): Promise<OcrResult> {
      overrides.onCall?.()
      return {
        providerId: overrides.id ?? "mock",
        pages: [
          { pageNumber: 1, markdown: "# page 1", text: "page 1" },
          { pageNumber: 2, markdown: "# page 2", text: "page 2" },
        ],
        combinedMarkdown: "",
        combinedText: "",
        languages: input.languages ?? [],
        durationMs: 0,
        cached: false,
      }
    },
  }
}

function makeDeps(overrides: Partial<ExtractDeps> = {}): ExtractDeps {
  const registry = overrides.registry ?? createOcrRegistry()
  return {
    registry,
    settings: overrides.settings ?? { ...DEFAULT_OCR_SETTINGS, defaultProviderId: "mock" },
    platform: overrides.platform ?? "web",
    osTag: overrides.osTag,
    credentialsResolver: overrides.credentialsResolver ?? (async () => ({ secrets: {} })),
    attachmentResolver: overrides.attachmentResolver,
    filePathResolver: overrides.filePathResolver,
    onResult: overrides.onResult,
  }
}

const sampleInput: OcrInput = {
  source: {
    kind: "data-url",
    dataUrl: "data:image/png;base64,YWJj",
    mimeType: "image/png",
  },
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

describe("extract — dispatch", () => {
  it("aborts immediately when the signal is already triggered", async () => {
    const deps = makeDeps()
    deps.registry.register(makeProvider({ id: "mock" }))
    const controller = new AbortController()
    controller.abort()
    await expect(
      extract({ ...sampleInput, signal: controller.signal }, deps)
    ).rejects.toMatchObject({ code: "aborted" })
  })

  it("resolves a data-url source and calls the provider", async () => {
    let called = 0
    const reg = createOcrRegistry()
    reg.register(makeProvider({ id: "mock", onCall: () => called++ }))
    const result = await extract(sampleInput, makeDeps({ registry: reg }))
    expect(called).toBe(1)
    expect(result.providerId).toBe("mock")
    expect(result.cached).toBe(false)
    expect(result.pages).toHaveLength(2)
  })

  it("rebuilds combined markdown / text from per-page entries when blank", async () => {
    const reg = createOcrRegistry()
    reg.register(makeProvider({ id: "mock" }))
    const result = await extract(sampleInput, makeDeps({ registry: reg }))
    expect(result.combinedMarkdown).toContain("page 1")
    expect(result.combinedMarkdown).toContain("page 2")
    expect(result.combinedMarkdown).toContain("---")
    expect(result.combinedText).toBe("page 1\n\npage 2")
  })

  it("honours an explicit providerId via the input", async () => {
    const reg = createOcrRegistry()
    reg.register(makeProvider({ id: "alpha" }))
    reg.register(makeProvider({ id: "beta" }))
    const result = await extract(
      { ...sampleInput, providerId: "beta" },
      makeDeps({ registry: reg })
    )
    expect(result.providerId).toBe("beta")
  })

  it("falls back to the auto-router when no providerId is set", async () => {
    const reg = createOcrRegistry()
    reg.register(makeProvider({ id: "tess", category: "local" }))
    reg.register(makeProvider({ id: "mistral", category: "document-cloud" }))
    const settings: UserOcrSettings = { ...DEFAULT_OCR_SETTINGS, defaultProviderId: "auto" }
    const result = await extract(
      sampleInput,
      makeDeps({ registry: reg, settings, platform: "web" })
    )
    // The web-default local engine is tesseract-wasm; we didn't register it,
    // so the router lands on the cloud fallback (mistral here, since it's the
    // only cloud provider) before the last-resort.
    expect(["tess", "mistral"]).toContain(result.providerId)
  })
})

describe("extract — source resolvers", () => {
  it("invokes the attachmentResolver for attachment-id sources", async () => {
    const reg = createOcrRegistry()
    reg.register(makeProvider({ id: "mock" }))
    const attachmentResolver = jest.fn(async () => ({
      blob: new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
      mimeType: "image/png",
    }))
    await extract(
      { source: { kind: "attachment-id", attachmentId: "att_1" } },
      makeDeps({ registry: reg, attachmentResolver })
    )
    expect(attachmentResolver).toHaveBeenCalledWith("att_1")
  })

  it("throws invalid_input when an attachment source has no resolver", async () => {
    const reg = createOcrRegistry()
    reg.register(makeProvider({ id: "mock" }))
    await expect(
      extract({ source: { kind: "attachment-id", attachmentId: "x" } }, makeDeps({ registry: reg }))
    ).rejects.toMatchObject({ code: "invalid_input" })
  })

  it("invokes the filePathResolver for file-path sources", async () => {
    const reg = createOcrRegistry()
    reg.register(makeProvider({ id: "mock" }))
    const filePathResolver = jest.fn(async () => ({
      blob: new Blob([new Uint8Array([4, 5, 6])], { type: "image/png" }),
      mimeType: "image/png",
    }))
    await extract(
      { source: { kind: "file-path", path: "/tmp/x.png" } },
      makeDeps({ registry: reg, filePathResolver })
    )
    expect(filePathResolver).toHaveBeenCalledWith("/tmp/x.png")
  })

  it("throws invalid_input when a file-path source has no resolver", async () => {
    const reg = createOcrRegistry()
    reg.register(makeProvider({ id: "mock" }))
    await expect(
      extract({ source: { kind: "file-path", path: "/tmp/x.png" } }, makeDeps({ registry: reg }))
    ).rejects.toMatchObject({ code: "invalid_input" })
  })

  it("throws invalid_input on a malformed data URL", async () => {
    const reg = createOcrRegistry()
    reg.register(makeProvider({ id: "mock" }))
    await expect(
      extract(
        {
          source: { kind: "data-url", dataUrl: "data:image/png,not-base64", mimeType: "image/png" },
        },
        makeDeps({ registry: reg })
      )
    ).rejects.toMatchObject({ code: "invalid_input" })
  })

  it("resolves a blob source inline", async () => {
    const reg = createOcrRegistry()
    reg.register(makeProvider({ id: "mock" }))
    const blob = new Blob([new Uint8Array([7, 8])], { type: "image/jpeg" })
    const result = await extract(
      { source: { kind: "blob", blob, mimeType: "image/jpeg" } },
      makeDeps({ registry: reg })
    )
    expect(result.providerId).toBe("mock")
  })
})

describe("extract — caching", () => {
  it("returns cached:true on the second call with the same input", async () => {
    let called = 0
    const reg = createOcrRegistry()
    reg.register(makeProvider({ id: "mock", onCall: () => called++ }))
    const deps = makeDeps({ registry: reg })
    const first = await extract(sampleInput, deps)
    const second = await extract(sampleInput, deps)
    expect(first.cached).toBe(false)
    expect(second.cached).toBe(true)
    expect(called).toBe(1)
  })

  it("skips both read and write when useCache is false", async () => {
    let called = 0
    const reg = createOcrRegistry()
    reg.register(makeProvider({ id: "mock", onCall: () => called++ }))
    const deps = makeDeps({ registry: reg })
    await extract({ ...sampleInput, useCache: false }, deps)
    await extract({ ...sampleInput, useCache: false }, deps)
    expect(called).toBe(2)
  })

  it("invokes onResult for every dispatch (cached or fresh)", async () => {
    const reg = createOcrRegistry()
    reg.register(makeProvider({ id: "mock" }))
    const onResult = jest.fn()
    const deps = makeDeps({ registry: reg, onResult })
    await extract(sampleInput, deps)
    await extract(sampleInput, deps)
    expect(onResult).toHaveBeenCalledTimes(2)
  })
})

describe("extract — error wrapping", () => {
  it("wraps a plain provider exception into provider_failed", async () => {
    const reg = createOcrRegistry()
    reg.register({
      ...makeProvider({ id: "boom" }),
      async extract() {
        throw new Error("network is down")
      },
    })
    await expect(
      extract({ ...sampleInput, providerId: "boom" }, makeDeps({ registry: reg }))
    ).rejects.toMatchObject({ code: "provider_failed", providerId: "boom" })
  })

  it("preserves a provider-thrown OcrError verbatim", async () => {
    const reg = createOcrRegistry()
    reg.register({
      ...makeProvider({ id: "ratelimited" }),
      async extract() {
        throw new OcrError("rate_limited", "ratelimited", "slow down")
      },
    })
    await expect(
      extract({ ...sampleInput, providerId: "ratelimited" }, makeDeps({ registry: reg }))
    ).rejects.toMatchObject({ code: "rate_limited" })
  })
})
