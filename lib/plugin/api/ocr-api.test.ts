import { __resetOcrApiForTesting, clearOcrProvidersForPlugin, createOcrAPI } from "./ocr-api"
import { __resetSharedOcrRegistry, getSharedOcrRegistry } from "@/lib/ocr/registry"
import type { OcrProvider, OcrInput, OcrProviderContext, OcrResult } from "@/lib/ocr/types"

function makeProvider(id: string): OcrProvider {
  return {
    id,
    label: `Provider ${id}`,
    category: "specialist",
    shells: { browser: true, tauri: true, capacitor: false },
    credentialKeys: [],
    extract: async (_input: OcrInput, _ctx: OcrProviderContext): Promise<OcrResult> => ({
      pages: [],
      providerId: id,
      combinedMarkdown: "",
      combinedText: "",
      languages: [],
      durationMs: 0,
      cached: false,
    }),
  }
}

describe("createOcrAPI", () => {
  beforeEach(() => {
    __resetOcrApiForTesting()
    __resetSharedOcrRegistry()
  })

  it("registers a provider under the prefixed plugin id", () => {
    const api = createOcrAPI("my-plugin")
    const reg = api.registerProvider(makeProvider("baidu"))
    expect(reg.providerId).toBe("my-plugin:baidu")
    expect(getSharedOcrRegistry().has("my-plugin:baidu")).toBe(true)
  })

  it("rejects a second registration with the same unprefixed id from the same plugin", () => {
    const api = createOcrAPI("p")
    api.registerProvider(makeProvider("dup"))
    expect(() => api.registerProvider(makeProvider("dup"))).toThrow(/already registered/i)
  })

  it("allows two plugins to register the same unprefixed id", () => {
    createOcrAPI("a").registerProvider(makeProvider("baidu"))
    createOcrAPI("b").registerProvider(makeProvider("baidu"))
    expect(getSharedOcrRegistry().has("a:baidu")).toBe(true)
    expect(getSharedOcrRegistry().has("b:baidu")).toBe(true)
  })

  it("unregister() removes the provider from the shared registry", () => {
    const api = createOcrAPI("p")
    const reg = api.registerProvider(makeProvider("x"))
    reg.unregister()
    expect(getSharedOcrRegistry().has("p:x")).toBe(false)
  })

  it("unregister() is idempotent", () => {
    const api = createOcrAPI("p")
    const reg = api.registerProvider(makeProvider("x"))
    reg.unregister()
    expect(() => reg.unregister()).not.toThrow()
  })

  it("clearOcrProvidersForPlugin drops every provider the plugin owns", () => {
    const api = createOcrAPI("p")
    api.registerProvider(makeProvider("a"))
    api.registerProvider(makeProvider("b"))
    expect(api.listRegistered()).toHaveLength(2)
    clearOcrProvidersForPlugin("p")
    expect(api.listRegistered()).toHaveLength(0)
    expect(getSharedOcrRegistry().has("p:a")).toBe(false)
    expect(getSharedOcrRegistry().has("p:b")).toBe(false)
  })
})
