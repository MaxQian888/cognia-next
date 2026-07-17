import {
  __resetSharedOcrRegistry,
  createOcrRegistry,
  getSharedOcrRegistry,
  registerOcrProvider,
  shellAllows,
} from "./registry"
import type { OcrProvider, OcrResult } from "@/types/ocr"

function makeProvider(overrides: Partial<OcrProvider> = {}): OcrProvider {
  return {
    id: overrides.id ?? "mock",
    label: overrides.label ?? "Mock",
    category: overrides.category ?? "document-cloud",
    shells: overrides.shells ?? { browser: true, tauri: true, capacitor: true },
    credentialKeys: overrides.credentialKeys ?? [],
    reusesMainProviderKey: overrides.reusesMainProviderKey,
    async extract(): Promise<OcrResult> {
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

describe("createOcrRegistry", () => {
  it("starts empty", () => {
    const reg = createOcrRegistry()
    expect(reg.list()).toEqual([])
  })

  it("registers and retrieves a provider", () => {
    const reg = createOcrRegistry()
    const p = makeProvider({ id: "a" })
    reg.register(p)
    expect(reg.has("a")).toBe(true)
    expect(reg.get("a")).toBe(p)
    expect(reg.list()).toEqual([p])
  })

  it("rejects duplicate ids", () => {
    const reg = createOcrRegistry()
    reg.register(makeProvider({ id: "a" }))
    expect(() => reg.register(makeProvider({ id: "a" }))).toThrow(/duplicate provider id/)
  })

  it("returns undefined for unknown ids", () => {
    expect(createOcrRegistry().get("missing")).toBeUndefined()
  })

  it("unregister removes a provider and reports whether it existed", () => {
    const reg = createOcrRegistry()
    reg.register(makeProvider({ id: "a" }))
    expect(reg.unregister("a")).toBe(true)
    expect(reg.unregister("a")).toBe(false)
    expect(reg.has("a")).toBe(false)
  })

  it("filters by category", () => {
    const reg = createOcrRegistry()
    reg.register(makeProvider({ id: "doc", category: "document-cloud" }))
    reg.register(makeProvider({ id: "vis", category: "llm-vision" }))
    reg.register(makeProvider({ id: "loc", category: "local" }))
    expect(reg.listByCategory("llm-vision").map((p) => p.id)).toEqual(["vis"])
    expect(reg.listByCategory("local").map((p) => p.id)).toEqual(["loc"])
  })

  it("filters by shell support", () => {
    const reg = createOcrRegistry()
    reg.register(
      makeProvider({
        id: "browser-only",
        shells: { browser: true, tauri: false, capacitor: false },
      })
    )
    reg.register(
      makeProvider({ id: "tauri-only", shells: { browser: false, tauri: true, capacitor: false } })
    )
    reg.register(
      makeProvider({ id: "mobile-only", shells: { browser: false, tauri: false, capacitor: true } })
    )
    expect(reg.listForShell("web").map((p) => p.id)).toEqual(["browser-only"])
    expect(reg.listForShell("tauri").map((p) => p.id)).toEqual(["tauri-only"])
    expect(reg.listForShell("mobile").map((p) => p.id)).toEqual(["mobile-only"])
  })

  it("clear empties the registry", () => {
    const reg = createOcrRegistry()
    reg.register(makeProvider({ id: "a" }))
    reg.register(makeProvider({ id: "b" }))
    reg.clear()
    expect(reg.list()).toEqual([])
  })
})

describe("shellAllows", () => {
  const provider = makeProvider({
    shells: { browser: true, tauri: false, capacitor: true },
  })
  it.each([
    ["tauri", false],
    ["mobile", true],
    ["web", true],
    ["headless", false],
  ] as const)("returns the matching shell flag (%s)", (platform, expected) => {
    expect(shellAllows(provider, platform)).toBe(expected)
  })
})

describe("shared singleton registry", () => {
  beforeEach(() => {
    __resetSharedOcrRegistry()
  })

  it("registerOcrProvider mutates the shared singleton", () => {
    registerOcrProvider(makeProvider({ id: "shared" }))
    expect(getSharedOcrRegistry().has("shared")).toBe(true)
  })

  it("__resetSharedOcrRegistry clears all entries", () => {
    registerOcrProvider(makeProvider({ id: "a" }))
    __resetSharedOcrRegistry()
    expect(getSharedOcrRegistry().list()).toEqual([])
  })
})
