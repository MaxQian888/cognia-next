import { DEFAULT_LOCAL_PREFERENCE, pickDefaultProvider, resolveProviderById } from "./auto-router"
import { createOcrRegistry } from "./registry"
import { DEFAULT_OCR_SETTINGS, OcrError, type OcrProvider, type UserOcrSettings } from "./types"

function makeProvider(overrides: Partial<OcrProvider> = {}): OcrProvider {
  return {
    id: overrides.id ?? "mock",
    label: overrides.label ?? "Mock",
    category: overrides.category ?? "local",
    shells: overrides.shells ?? { browser: true, tauri: true, capacitor: true },
    credentialKeys: overrides.credentialKeys ?? [],
    async extract() {
      return {
        providerId: overrides.id ?? "mock",
        pages: [{ pageNumber: 1, markdown: "x", text: "x" }],
        combinedMarkdown: "x",
        combinedText: "x",
        languages: [],
        durationMs: 0,
        cached: false,
      }
    },
  }
}

function settings(overrides: Partial<UserOcrSettings> = {}): UserOcrSettings {
  return { ...DEFAULT_OCR_SETTINGS, ...overrides }
}

describe("DEFAULT_LOCAL_PREFERENCE", () => {
  it("seeds tesseract-wasm as the browser fallback", () => {
    expect(DEFAULT_LOCAL_PREFERENCE.browser[0]).toBe("tesseract-wasm")
  })

  it("seeds windows-media-ocr ahead of tesseract on Windows", () => {
    expect(DEFAULT_LOCAL_PREFERENCE.windows[0]).toBe("windows-media-ocr")
  })

  it("seeds apple-vision on macOS and iOS", () => {
    expect(DEFAULT_LOCAL_PREFERENCE.macos[0]).toBe("apple-vision")
    expect(DEFAULT_LOCAL_PREFERENCE.ios[0]).toBe("apple-vision")
  })

  it("seeds mlkit-android as the Android default", () => {
    expect(DEFAULT_LOCAL_PREFERENCE.android[0]).toBe("mlkit-android")
  })
})

describe("pickDefaultProvider", () => {
  it("honours an explicit defaultProviderId when usable", async () => {
    const reg = createOcrRegistry()
    reg.register(makeProvider({ id: "tess", category: "local" }))
    reg.register(makeProvider({ id: "mistral", category: "document-cloud" }))
    const picked = await pickDefaultProvider({
      registry: reg,
      settings: settings({ defaultProviderId: "mistral" }),
      platform: "web",
    })
    expect(picked.id).toBe("mistral")
  })

  it("ignores an explicit pin when the provider is disabled", async () => {
    const reg = createOcrRegistry()
    reg.register(makeProvider({ id: "tess", category: "local" }))
    reg.register(makeProvider({ id: "mistral", category: "document-cloud" }))
    const picked = await pickDefaultProvider({
      registry: reg,
      settings: settings({
        defaultProviderId: "mistral",
        providerEnabled: { mistral: false },
      }),
      platform: "web",
      hasCredentials: () => false,
    })
    // mistral is disabled → falls through to tesseract local pick
    expect(picked.id).toBe("tess")
  })

  it("prefers the platform-local engine when defaultProviderId is auto", async () => {
    const reg = createOcrRegistry()
    reg.register(makeProvider({ id: "tesseract-wasm", category: "local" }))
    reg.register(makeProvider({ id: "windows-media-ocr", category: "local" }))
    reg.register(makeProvider({ id: "mistral-ocr", category: "document-cloud" }))
    const picked = await pickDefaultProvider({
      registry: reg,
      settings: settings({ cloudFallbackProviderId: "mistral-ocr" }),
      platform: "tauri",
      osTag: "windows",
    })
    expect(picked.id).toBe("windows-media-ocr")
  })

  it("skips local engines that report not-ready", async () => {
    const reg = createOcrRegistry()
    reg.register(makeProvider({ id: "windows-media-ocr", category: "local" }))
    reg.register(makeProvider({ id: "tesseract-native", category: "local" }))
    reg.register(makeProvider({ id: "tesseract-wasm", category: "local" }))
    const picked = await pickDefaultProvider({
      registry: reg,
      settings: settings(),
      platform: "tauri",
      osTag: "windows",
      localReadiness: (id) => id !== "windows-media-ocr",
    })
    expect(picked.id).toBe("tesseract-native")
  })

  it("falls through to the cloud fallback when no local engine is ready", async () => {
    const reg = createOcrRegistry()
    reg.register(makeProvider({ id: "mistral-ocr", category: "document-cloud" }))
    const picked = await pickDefaultProvider({
      registry: reg,
      settings: settings({ cloudFallbackProviderId: "mistral-ocr" }),
      platform: "tauri",
      osTag: "linux",
      hasCredentials: () => true,
    })
    expect(picked.id).toBe("mistral-ocr")
  })

  it("skips cloud providers that report missing credentials", async () => {
    const reg = createOcrRegistry()
    reg.register(makeProvider({ id: "mistral-ocr", category: "document-cloud" }))
    reg.register(makeProvider({ id: "google-vision", category: "document-cloud" }))
    const picked = await pickDefaultProvider({
      registry: reg,
      settings: settings({ cloudFallbackProviderId: "mistral-ocr" }),
      platform: "tauri",
      osTag: "linux",
      hasCredentials: (id) => id === "google-vision",
    })
    expect(picked.id).toBe("google-vision")
  })

  it("returns the last-resort provider when no preferred engine matches", async () => {
    const reg = createOcrRegistry()
    reg.register(
      makeProvider({
        id: "weird",
        category: "document-cloud",
        shells: { browser: true, tauri: true, capacitor: false },
      })
    )
    const picked = await pickDefaultProvider({
      registry: reg,
      settings: settings({ cloudFallbackEnabled: false }),
      platform: "tauri",
      osTag: "linux",
    })
    expect(picked.id).toBe("weird")
  })

  it("throws when no provider is available", async () => {
    const reg = createOcrRegistry()
    await expect(
      pickDefaultProvider({ registry: reg, settings: settings(), platform: "web" })
    ).rejects.toThrow(OcrError)
  })

  it("throws when the only registered provider doesn't support the shell", async () => {
    const reg = createOcrRegistry()
    reg.register(
      makeProvider({
        id: "tauri-only",
        category: "local",
        shells: { browser: false, tauri: true, capacitor: false },
      })
    )
    await expect(
      pickDefaultProvider({ registry: reg, settings: settings(), platform: "web" })
    ).rejects.toThrow(/No OCR provider/)
  })

  it("supports caller-supplied localPreference overrides", async () => {
    const reg = createOcrRegistry()
    reg.register(makeProvider({ id: "custom-local", category: "local" }))
    const picked = await pickDefaultProvider({
      registry: reg,
      settings: settings(),
      platform: "tauri",
      osTag: "linux",
      localPreference: { linux: ["custom-local"] },
    })
    expect(picked.id).toBe("custom-local")
  })
})

describe("resolveProviderById", () => {
  it("returns the provider when registered and shell-compatible", () => {
    const reg = createOcrRegistry()
    const p = makeProvider({ id: "a" })
    reg.register(p)
    expect(resolveProviderById(reg, "a", "web")).toBe(p)
  })

  it("throws provider_failed for unknown ids", () => {
    const reg = createOcrRegistry()
    expect(() => resolveProviderById(reg, "missing", "web")).toThrow(
      expect.objectContaining({ code: "provider_failed" })
    )
  })

  it("throws unsupported_shell when the provider can't run in the current shell", () => {
    const reg = createOcrRegistry()
    reg.register(
      makeProvider({
        id: "tauri-only",
        shells: { browser: false, tauri: true, capacitor: false },
      })
    )
    expect(() => resolveProviderById(reg, "tauri-only", "web")).toThrow(
      expect.objectContaining({ code: "unsupported_shell" })
    )
  })
})
