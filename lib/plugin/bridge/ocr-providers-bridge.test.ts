import {
  registerOcrProvidersForPlugin,
  unregisterOcrProvidersForPlugin,
} from "./ocr-providers-bridge"
import { __resetSharedOcrRegistry, getSharedOcrRegistry } from "@/lib/ocr/registry"
import { __resetOcrApiForTesting } from "@/lib/plugin/api/ocr-api"
import type { PluginManifest } from "@/types/plugin/plugin"
import type { OcrProvider } from "@/types/ocr"
import { createDescribedPythonContribution } from "@/lib/plugin/bridge/_shared/python-backed-proxy"

jest.mock("@/lib/plugin/bridge/_shared/python-backed-proxy", () => ({
  ...jest.requireActual("@/lib/plugin/bridge/_shared/python-backed-proxy"),
  createDescribedPythonContribution: jest.fn(),
}))

const mockCreateDescribed = createDescribedPythonContribution as jest.MockedFunction<
  typeof createDescribedPythonContribution
>

const minimalManifest = (overrides: Partial<PluginManifest>): PluginManifest =>
  ({
    id: "test-plugin",
    name: "Test",
    version: "1.0.0",
    description: "",
    type: "frontend",
    capabilities: ["tools"],
    main: "index.js",
    ...overrides,
  }) as PluginManifest

function fakeProvider(id: string): OcrProvider {
  return {
    id,
    label: id,
    category: "specialist",
    shells: { browser: true, tauri: true, capacitor: false },
    credentialKeys: [],
    extract: async () => ({
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

describe("ocr-providers-bridge", () => {
  beforeEach(() => {
    __resetSharedOcrRegistry()
    __resetOcrApiForTesting()
    mockCreateDescribed.mockReset()
  })

  it("registers every entry in manifest.ocrProviders", async () => {
    const manifest = minimalManifest({
      ocrProviders: [
        { id: "a", label: "A", entry: "providers/a.js", export: "createA" },
        { id: "b", label: "B", entry: "providers/b.js", export: "createB" },
      ],
    })
    const importer = jest.fn(async (entry: string) => {
      if (entry.endsWith("providers/a.js")) return { createA: () => fakeProvider("a") }
      if (entry.endsWith("providers/b.js")) return { createB: () => fakeProvider("b") }
      throw new Error(`unexpected entry ${entry}`)
    })

    const result = await registerOcrProvidersForPlugin(manifest, "/plugins/test", { importer })

    expect(result).toEqual({ registered: 2, errors: [] })
    expect(getSharedOcrRegistry().has("test-plugin:a")).toBe(true)
    expect(getSharedOcrRegistry().has("test-plugin:b")).toBe(true)
  })

  it("collects errors per failing entry without throwing", async () => {
    const manifest = minimalManifest({
      ocrProviders: [
        { id: "good", label: "Good", entry: "ok.js", export: "createGood" },
        { id: "bad", label: "Bad", entry: "missing-export.js", export: "missing" },
      ],
    })
    const importer = jest.fn(async (entry: string) => {
      if (entry.endsWith("ok.js")) return { createGood: () => fakeProvider("good") }
      return { somethingElse: () => fakeProvider("nope") }
    })

    const result = await registerOcrProvidersForPlugin(manifest, "/plugins/test", { importer })

    expect(result.registered).toBe(1)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]!.providerId).toBe("bad")
    expect(getSharedOcrRegistry().has("test-plugin:good")).toBe(true)
    expect(getSharedOcrRegistry().has("test-plugin:bad")).toBe(false)
  })

  it("unregisterOcrProvidersForPlugin drops every contributed provider", async () => {
    const manifest = minimalManifest({
      ocrProviders: [{ id: "x", label: "X", entry: "x.js", export: "createX" }],
    })
    const importer = jest.fn(async () => ({ createX: () => fakeProvider("x") }))

    await registerOcrProvidersForPlugin(manifest, "/plugins/test", { importer })
    expect(getSharedOcrRegistry().has("test-plugin:x")).toBe(true)
    unregisterOcrProvidersForPlugin("test-plugin")
    expect(getSharedOcrRegistry().has("test-plugin:x")).toBe(false)
  })

  it("returns zero registrations when manifest has no ocrProviders", async () => {
    const result = await registerOcrProvidersForPlugin(minimalManifest({}), "/plugins/test")
    expect(result).toEqual({ registered: 0, errors: [] })
  })

  it("resolves a python-backed provider through the seam instead of importing JS", async () => {
    mockCreateDescribed.mockResolvedValue(fakeProvider("py") as unknown as never)
    const manifest = minimalManifest({
      type: "python",
      pythonMain: "main.py",
      main: undefined,
      ocrProviders: [{ id: "py", label: "Py" }],
    })
    const importer = jest.fn()

    const result = await registerOcrProvidersForPlugin(manifest, "/plugins/test", { importer })

    expect(result).toEqual({ registered: 1, errors: [] })
    expect(importer).not.toHaveBeenCalled()
    expect(mockCreateDescribed).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: "test-plugin",
        contributionId: "py",
        methods: ["extract"],
      })
    )
    expect(getSharedOcrRegistry().has("test-plugin:py")).toBe(true)
  })

  it("still imports JS when a python plugin pins backend: js", async () => {
    const manifest = minimalManifest({
      type: "python",
      pythonMain: "main.py",
      ocrProviders: [{ id: "js", label: "Js", backend: "js", entry: "j.js", export: "createJs" }],
    })
    const importer = jest.fn(async () => ({ createJs: () => fakeProvider("js") }))

    const result = await registerOcrProvidersForPlugin(manifest, "/plugins/test", { importer })

    expect(result.registered).toBe(1)
    expect(importer).toHaveBeenCalled()
    expect(mockCreateDescribed).not.toHaveBeenCalled()
  })

  it("rejects a python descriptor that is not a valid OcrProvider", async () => {
    mockCreateDescribed.mockResolvedValue({ extract: () => {} } as unknown as never)
    const manifest = minimalManifest({
      type: "python",
      pythonMain: "main.py",
      ocrProviders: [{ id: "bad", label: "Bad" }],
    })

    const result = await registerOcrProvidersForPlugin(manifest, "/plugins/test", {
      importer: jest.fn(),
    })

    expect(result.registered).toBe(0)
    expect(result.errors[0]!.message).toMatch(/invalid OcrProvider descriptor/i)
  })

  it("rejects a JS-backed provider that omits entry or export", async () => {
    const manifest = minimalManifest({
      ocrProviders: [{ id: "incomplete", label: "Incomplete" }],
    })

    const result = await registerOcrProvidersForPlugin(manifest, "/plugins/test", {
      importer: jest.fn(),
    })

    expect(result.registered).toBe(0)
    expect(result.errors[0]!.message).toMatch(/must declare both "entry" and "export"/)
  })

  it("rejects factories that return an object without extract()", async () => {
    const manifest = minimalManifest({
      ocrProviders: [{ id: "broken", label: "Broken", entry: "b.js", export: "createBroken" }],
    })
    const importer = jest.fn(async () => ({ createBroken: () => ({ id: "broken" }) }))

    const result = await registerOcrProvidersForPlugin(manifest, "/plugins/test", { importer })
    expect(result.registered).toBe(0)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]!.message).toMatch(/invalid OcrProvider/i)
  })
})
