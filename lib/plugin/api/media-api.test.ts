/**
 * @jest-environment jsdom
 *
 * Tests for Media Plugin API - Registry Functions
 *
 * jsdom omits the canvas-API `ImageData` constructor, so we polyfill a
 * minimal shape here before the tests run. This is sufficient for the
 * registry tests below — production code uses the real browser
 * `ImageData`.
 */
if (typeof globalThis.ImageData === "undefined") {
  class ImageDataPolyfill {
    readonly data: Uint8ClampedArray
    readonly width: number
    readonly height: number
    constructor(data: Uint8ClampedArray | number, widthOrHeight?: number, height?: number) {
      if (data instanceof Uint8ClampedArray) {
        this.data = data
        this.width = widthOrHeight ?? Math.sqrt(data.length / 4)
        this.height = height ?? this.width
      } else {
        const w = data
        const h = widthOrHeight ?? data
        this.width = w
        this.height = h
        this.data = new Uint8ClampedArray(w * h * 4)
      }
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(globalThis as any).ImageData = ImageDataPolyfill
}

import {
  createMediaAPI,
  getMediaRegistry,
  type ImageFilterDefinition,
  type VideoEffectDefinition,
  type VideoTransitionDefinition,
} from "./media-api"
import { invoke } from "@tauri-apps/api/core"
import { proxyFetch } from "@/lib/network/proxy-fetch"
import {
  clearAllPluginPointDiagnostics,
  getPluginPointDiagnostics,
} from "../contracts/diagnostics-store"

jest.mock("@tauri-apps/api/core", () => ({
  invoke: jest.fn(),
}))

jest.mock("@tauri-apps/api/event", () => ({
  listen: jest.fn(async () => () => undefined),
}))

jest.mock("@tauri-apps/plugin-fs", () => ({
  writeFile: jest.fn(async () => undefined),
  exists: jest.fn(async () => false),
}))

jest.mock("@/lib/utils", () => ({
  isTauri: jest.fn(() => true),
}))

jest.mock("@/lib/network/proxy-fetch", () => ({
  proxyFetch: jest.fn(),
}))

jest.mock("@/stores", () => ({
  useSettingsStore: {
    getState: jest.fn(() => ({
      defaultProvider: "openai",
      providerSettings: {
        openai: {
          providerId: "openai",
          apiKey: "sk-openai",
          enabled: true,
          defaultModel: "gpt-4o",
        },
      },
      customProviders: [],
    })),
  },
}))

const mockUseSettingsStoreGetState = jest.requireMock("@/stores").useSettingsStore
  .getState as jest.Mock

class MockOffscreenCanvas {
  public width: number
  public height: number
  private imageData: ImageData

  constructor(width: number, height: number) {
    this.width = width
    this.height = height
    this.imageData = new ImageData(new Uint8ClampedArray(width * height * 4), width, height)
  }

  getContext() {
    return {
      drawImage: jest.fn(),
      putImageData: jest.fn((imageData: ImageData) => {
        this.imageData = imageData
      }),
      getImageData: jest.fn((x = 0, y = 0, width = this.width, height = this.height) => {
        void x
        void y
        return new ImageData(new Uint8ClampedArray(width * height * 4), width, height)
      }),
    }
  }

  convertToBlob() {
    return Promise.resolve(new Blob(["mock-image"], { type: "image/png" }))
  }
}

class MockImage {
  onload: null | (() => void) = null
  onerror: null | (() => void) = null
  width = 4
  height = 4

  set src(_value: string) {
    queueMicrotask(() => {
      this.onload?.()
    })
  }
}

;(global as unknown as { OffscreenCanvas: typeof MockOffscreenCanvas }).OffscreenCanvas =
  MockOffscreenCanvas as never
;(global as unknown as { Image: typeof MockImage }).Image = MockImage as never

Object.defineProperty(HTMLCanvasElement.prototype, "toDataURL", {
  value: jest.fn(() => "data:image/png;base64,bW9jay1kYXRhLXVybA=="),
  configurable: true,
})

// jsdom doesn't ship the canvas 2D context — provide a minimal stub so
// `document.createElement("canvas").getContext("2d")` returns a usable
// object for `imageDataToDataUrl` and similar source-side helpers.
Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
  value: jest.fn(() => ({
    drawImage: jest.fn(),
    putImageData: jest.fn(),
    getImageData: jest.fn(
      (_x: number, _y: number, w: number, h: number) =>
        new ImageData(new Uint8ClampedArray(w * h * 4), w, h)
    ),
    fillRect: jest.fn(),
    clearRect: jest.fn(),
    canvas: { width: 0, height: 0 },
  })),
  configurable: true,
})

describe("Media Registry", () => {
  const testPluginId = "test-plugin"

  // Helper to create prefixed IDs
  const prefixId = (id: string) => `${testPluginId}:${id}`

  const createTestImageData = (width = 2, height = 2): ImageData =>
    new ImageData(new Uint8ClampedArray(width * height * 4).fill(180), width, height)

  const mockImageEditResponse = () => {
    ;(proxyFetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ b64_json: "ZmFrZQ==" }],
      }),
      text: async () => "",
    })
  }

  // Cleanup after each test
  afterEach(() => {
    jest.useRealTimers()
    jest.clearAllMocks()
    mockUseSettingsStoreGetState.mockReturnValue({
      defaultProvider: "openai",
      providerSettings: {
        openai: {
          providerId: "openai",
          apiKey: "sk-openai",
          enabled: true,
          defaultModel: "gpt-4o",
        },
      },
      customProviders: [],
    })

    const registry = getMediaRegistry()
    // Clean up test filters
    registry.getAllFilters().forEach((f: ImageFilterDefinition) => {
      if (f.id.startsWith(`${testPluginId}:`)) {
        registry.unregisterFilter(f.id)
      }
    })
    // Clean up test effects
    registry.getAllEffects().forEach((e: VideoEffectDefinition) => {
      if (e.id.startsWith(`${testPluginId}:`)) {
        registry.unregisterEffect(e.id)
      }
    })
    // Clean up test transitions
    registry.getAllTransitions().forEach((t: VideoTransitionDefinition) => {
      if (t.id.startsWith(`${testPluginId}:`)) {
        registry.unregisterTransition(t.id)
      }
    })
  })

  describe("Filter Registry", () => {
    const createTestFilter = (id: string): ImageFilterDefinition => ({
      id: id,
      name: `Test Filter ${id}`,
      description: "A test filter",
      category: "color",
      parameters: [{ id: "amount", name: "Amount", type: "number", default: 50, min: 0, max: 100 }],
      apply: (imageData) => imageData,
    })

    it("should register a filter", () => {
      const registry = getMediaRegistry()
      const filter = createTestFilter("my-filter")

      registry.registerFilter(testPluginId, filter)

      const registered = registry.getFilter(prefixId("my-filter"))
      expect(registered).toBeDefined()
      expect(registered?.name).toBe("Test Filter my-filter")
    })

    it("should unregister a filter", () => {
      const registry = getMediaRegistry()
      const filter = createTestFilter("to-remove")

      registry.registerFilter(testPluginId, filter)
      registry.unregisterFilter(prefixId("to-remove"))

      const result = registry.getFilter(prefixId("to-remove"))
      expect(result).toBeUndefined()
    })

    it("should get all filters", () => {
      const registry = getMediaRegistry()
      registry.registerFilter(testPluginId, createTestFilter("filter-1"))
      registry.registerFilter(testPluginId, createTestFilter("filter-2"))

      const filters = registry.getAllFilters()

      expect(Array.isArray(filters)).toBe(true)
      expect(filters.length).toBeGreaterThanOrEqual(2)
    })

    it("should get filters by category", () => {
      const registry = getMediaRegistry()
      const colorFilter: ImageFilterDefinition = {
        ...createTestFilter("color-filter"),
        category: "color",
      }
      const stylizeFilter: ImageFilterDefinition = {
        ...createTestFilter("stylize-filter"),
        category: "stylize",
      }

      registry.registerFilter(testPluginId, colorFilter)
      registry.registerFilter(testPluginId, stylizeFilter)

      const colorFilters = registry.getFiltersByCategory("color")
      const stylizeFilters = registry.getFiltersByCategory("stylize")

      expect(
        colorFilters.some((f: ImageFilterDefinition) => f.id === prefixId("color-filter"))
      ).toBe(true)
      expect(
        stylizeFilters.some((f: ImageFilterDefinition) => f.id === prefixId("stylize-filter"))
      ).toBe(true)
    })

    it("should return undefined for non-existent filter", () => {
      const registry = getMediaRegistry()

      const result = registry.getFilter("non-existent-filter")

      expect(result).toBeUndefined()
    })
  })

  describe("Effect Registry", () => {
    const createTestEffect = (id: string): VideoEffectDefinition => ({
      id: id,
      name: `Test Effect ${id}`,
      description: "A test video effect",
      category: "color",
      parameters: [
        { id: "intensity", name: "Intensity", type: "number", default: 100, min: 0, max: 100 },
      ],
      apply: (frame) => frame,
    })

    it("should register an effect", () => {
      const registry = getMediaRegistry()
      const effect = createTestEffect("my-effect")

      registry.registerEffect(testPluginId, effect)

      const registered = registry.getEffect(prefixId("my-effect"))
      expect(registered).toBeDefined()
      expect(registered?.name).toBe("Test Effect my-effect")
    })

    it("should unregister an effect", () => {
      const registry = getMediaRegistry()
      const effect = createTestEffect("to-remove")

      registry.registerEffect(testPluginId, effect)
      registry.unregisterEffect(prefixId("to-remove"))

      const result = registry.getEffect(prefixId("to-remove"))
      expect(result).toBeUndefined()
    })

    it("should get all effects", () => {
      const registry = getMediaRegistry()
      registry.registerEffect(testPluginId, createTestEffect("effect-1"))
      registry.registerEffect(testPluginId, createTestEffect("effect-2"))

      const effects = registry.getAllEffects()

      expect(Array.isArray(effects)).toBe(true)
      expect(effects.length).toBeGreaterThanOrEqual(2)
    })

    it("should return undefined for non-existent effect", () => {
      const registry = getMediaRegistry()

      const result = registry.getEffect("non-existent-effect")

      expect(result).toBeUndefined()
    })
  })

  describe("Transition Registry", () => {
    const createTestTransition = (id: string): VideoTransitionDefinition => ({
      id: id,
      name: `Test Transition ${id}`,
      description: "A test transition",
      minDuration: 0.1,
      maxDuration: 5,
      defaultDuration: 1,
      render: (from) => from,
    })

    it("should register a transition", () => {
      const registry = getMediaRegistry()
      const transition = createTestTransition("my-transition")

      registry.registerTransition(testPluginId, transition)

      const registered = registry.getTransition(prefixId("my-transition"))
      expect(registered).toBeDefined()
      expect(registered?.name).toBe("Test Transition my-transition")
    })

    it("should unregister a transition", () => {
      const registry = getMediaRegistry()
      const transition = createTestTransition("to-remove")

      registry.registerTransition(testPluginId, transition)
      registry.unregisterTransition(prefixId("to-remove"))

      const result = registry.getTransition(prefixId("to-remove"))
      expect(result).toBeUndefined()
    })

    it("should get all transitions", () => {
      const registry = getMediaRegistry()
      registry.registerTransition(testPluginId, createTestTransition("transition-1"))
      registry.registerTransition(testPluginId, createTestTransition("transition-2"))

      const transitions = registry.getAllTransitions()

      expect(Array.isArray(transitions)).toBe(true)
      expect(transitions.length).toBeGreaterThanOrEqual(2)
    })

    it("should return undefined for non-existent transition", () => {
      const registry = getMediaRegistry()

      const result = registry.getTransition("non-existent-transition")

      expect(result).toBeUndefined()
    })
  })

  describe("Registry Singleton", () => {
    it("should return the same registry instance", () => {
      const registry1 = getMediaRegistry()
      const registry2 = getMediaRegistry()

      expect(registry1).toBe(registry2)
    })

    it("should persist registrations across calls", () => {
      const registry1 = getMediaRegistry()
      const filter: ImageFilterDefinition = {
        id: "persistent-filter",
        name: "Persistent Filter",
        category: "color",
        apply: (img) => img,
      }

      registry1.registerFilter(testPluginId, filter)

      const registry2 = getMediaRegistry()
      const retrieved = registry2.getFilter(prefixId("persistent-filter"))

      expect(retrieved).toBeDefined()
      expect(retrieved?.name).toBe("Persistent Filter")
    })
  })

  describe("Catalog bridge", () => {
    it("should expose a shared media catalog registration bridge", () => {
      const api = createMediaAPI(testPluginId, {} as never)
      const addAsset = jest.fn(() => "catalog-asset-id")

      const assetId = api.utils.registerCatalogAsset(
        { addAsset },
        {
          kind: "image",
          name: "plugin-output.png",
          mimeType: "image/png",
          dataUrl: "data:image/png;base64,abc123",
          width: 512,
          height: 512,
        }
      )

      expect(assetId).toBe("catalog-asset-id")
      expect(addAsset).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "image",
          origin: expect.objectContaining({
            type: "plugin",
            sourceId: `${testPluginId}:plugin-output.png`,
          }),
        })
      )
    })
  })

  describe("Video API implementation", () => {
    beforeEach(() => {
      ;(invoke as jest.Mock).mockImplementation(async (command: string) => {
        if (command === "video_get_info") {
          return {
            durationMs: 12_000,
            width: 1920,
            height: 1080,
            fps: 30,
            codec: "h264",
            fileSize: 1024,
            hasAudio: true,
          }
        }
        if (command === "plugin_media_get_video_frame") {
          return {
            data: new Uint8Array(4 * 2 * 2),
            width: 2,
            height: 2,
          }
        }
        if (command === "plugin_media_concatenate_videos") {
          return {
            id: "merged",
            sourceUrl: "/tmp/merged.mp4",
            startTime: 0,
            endTime: 12,
            duration: 12,
            position: 0,
            track: 0,
            filters: [],
          }
        }
        if (command === "plugin_media_export_video") {
          return new Uint8Array([1, 2, 3, 4])
        }
        return undefined
      })
    })

    it("should provide a real frame extraction path", async () => {
      const api = createMediaAPI(testPluginId, {} as never)
      const imageData = await api.video.getFrame("clip-id", 1.5)
      expect(imageData).toBeInstanceOf(ImageData)
      expect(imageData.width).toBe(2)
      expect(invoke).toHaveBeenCalledWith(
        "plugin_media_get_video_frame",
        expect.objectContaining({ clipId: "clip-id", time: 1.5 })
      )
    })

    it("should concatenate clips without throwing NOT_SUPPORTED", async () => {
      const api = createMediaAPI(testPluginId, {} as never)
      const clip = await api.video.concatenate(["clip-1", "clip-2"])
      expect(clip.id).toBe("merged")
      expect(invoke).toHaveBeenCalledWith(
        "plugin_media_concatenate_videos",
        expect.objectContaining({ clipIds: ["clip-1", "clip-2"] })
      )
    })

    it("should apply effect and transition without throwing", async () => {
      const api = createMediaAPI(testPluginId, {} as never)
      const loaded = await api.video.loadClip("/tmp/source.mp4")
      await expect(
        api.video.applyEffect(loaded.id, "brightness-contrast", { brightness: 12 })
      ).resolves.toBeUndefined()
      await expect(
        api.video.addTransition(loaded.id, "clip-2", { type: "fade", duration: 1 })
      ).resolves.toBeUndefined()
    })

    it("should export video to blob", async () => {
      const api = createMediaAPI(testPluginId, {} as never)
      const blob = await api.video.export(["clip-1"], {
        format: "mp4",
        resolution: "1080p",
        fps: 30,
        quality: "high",
      })
      expect(blob).toBeInstanceOf(Blob)
      expect(blob.size).toBe(4)
    })
  })

  describe("AI image processing implementation", () => {
    it("routes upscale requests through the configured image provider", async () => {
      mockImageEditResponse()
      const api = createMediaAPI(testPluginId, {} as never)

      const result = await api.ai.upscale(createTestImageData(), 4)

      expect(result).toBeInstanceOf(ImageData)
      expect(proxyFetch).toHaveBeenCalledTimes(1)
      expect((proxyFetch as jest.Mock).mock.calls[0][0]).toBe(
        "https://api.openai.com/v1/images/edits"
      )

      const request = (proxyFetch as jest.Mock).mock.calls[0][1] as { body: FormData }
      expect(request.body.get("model")).toBe("gpt-image-1")
      expect(request.body.get("prompt")).toContain("4x")
    })

    it("routes background removal and enhancement requests through the provider edit endpoint", async () => {
      mockImageEditResponse()
      const api = createMediaAPI(testPluginId, {} as never)

      await api.ai.removeBackground(createTestImageData())
      await api.ai.enhanceImage(createTestImageData(), "restore")

      const removeRequest = (proxyFetch as jest.Mock).mock.calls[0][1] as { body: FormData }
      const enhanceRequest = (proxyFetch as jest.Mock).mock.calls[1][1] as { body: FormData }

      expect(removeRequest.body.get("prompt")).toContain("Remove the background")
      expect(enhanceRequest.body.get("prompt")).toContain("restore")
    })

    it("routes variation and inpaint requests with prompt and mask payloads", async () => {
      mockImageEditResponse()
      const api = createMediaAPI(testPluginId, {} as never)

      await api.ai.generateVariation(createTestImageData(), "make it cyberpunk")
      await api.ai.inpaint(createTestImageData(), createTestImageData(), "replace the sky")

      const variationRequest = (proxyFetch as jest.Mock).mock.calls[0][1] as { body: FormData }
      const inpaintRequest = (proxyFetch as jest.Mock).mock.calls[1][1] as { body: FormData }

      expect(variationRequest.body.get("prompt")).toContain("make it cyberpunk")
      expect(inpaintRequest.body.get("prompt")).toContain("replace the sky")
      expect(inpaintRequest.body.get("mask")).toBeInstanceOf(File)
    })

    it("serializes xAI image edits as JSON requests instead of multipart form data", async () => {
      mockImageEditResponse()
      mockUseSettingsStoreGetState.mockReturnValue({
        defaultProvider: "xai",
        providerSettings: {
          xai: {
            providerId: "xai",
            apiKey: "sk-xai",
            enabled: true,
            defaultModel: "grok-2-image",
          },
        },
        customProviders: [],
      })
      const api = createMediaAPI(testPluginId, {} as never)

      await api.ai.removeBackground(createTestImageData())

      expect(proxyFetch).toHaveBeenCalledTimes(1)
      expect((proxyFetch as jest.Mock).mock.calls[0][0]).toBe("https://api.x.ai/v1/images/edits")

      const request = (proxyFetch as jest.Mock).mock.calls[0][1] as {
        body: string
        headers: Record<string, string>
      }
      const body = JSON.parse(request.body)

      expect(request.headers).toMatchObject({
        Authorization: "Bearer sk-xai",
        "Content-Type": "application/json",
      })
      expect(body.model).toBe("grok-2-image")
      expect(body.prompt).toContain("Remove the background")
      expect(body.image).toEqual(
        expect.objectContaining({
          type: "image_url",
        })
      )
      expect(body.image.url).toMatch(/^data:image\/png;base64,/)
    })

    it("throws a structured provider error when xAI receives a mask edit request", async () => {
      mockUseSettingsStoreGetState.mockReturnValue({
        defaultProvider: "xai",
        providerSettings: {
          xai: {
            providerId: "xai",
            apiKey: "sk-xai",
            enabled: true,
            defaultModel: "grok-2-image",
          },
        },
        customProviders: [],
      })
      const api = createMediaAPI(testPluginId, {} as never)

      await expect(
        api.ai.inpaint(createTestImageData(), createTestImageData(), "replace the sky")
      ).rejects.toMatchObject({
        code: "PROVIDER_ERROR",
        suggestion: expect.stringContaining("OpenAI"),
      })
      expect(proxyFetch).not.toHaveBeenCalled()
    })

    it("throws a structured NO_IMAGE_PROVIDER error when no eligible provider is configured", async () => {
      mockUseSettingsStoreGetState.mockReturnValue({
        defaultProvider: "openai",
        providerSettings: {
          openai: {
            providerId: "openai",
            enabled: true,
            defaultModel: "gpt-4o",
          },
        },
        customProviders: [],
      })

      const api = createMediaAPI(testPluginId, {} as never)

      await expect(api.ai.removeBackground(createTestImageData())).rejects.toMatchObject({
        code: "NO_IMAGE_PROVIDER",
        suggestion: expect.stringContaining("Settings"),
      })
      expect(proxyFetch).not.toHaveBeenCalled()
    })

    it("throws TIMEOUT when the provider request exceeds 30 seconds", async () => {
      jest.useFakeTimers()
      ;(proxyFetch as jest.Mock).mockImplementation(() => new Promise(() => undefined))
      const api = createMediaAPI(testPluginId, {} as never)

      const request = api.ai.generateVariation(createTestImageData(), "timed out")
      const expectation = expect(request).rejects.toMatchObject({
        code: "TIMEOUT",
      })
      await jest.advanceTimersByTimeAsync(30_000)

      await expectation
    })

    it("records a diagnostic when ai.upscale provider call rejects (ADR 0016 T1)", async () => {
      clearAllPluginPointDiagnostics()
      ;(proxyFetch as jest.Mock).mockRejectedValue(new Error("provider down"))
      const api = createMediaAPI(testPluginId, {} as never)

      await expect(api.ai.upscale(createTestImageData(), 4)).rejects.toThrow("provider down")

      const diagnostics = getPluginPointDiagnostics(testPluginId)
      expect(diagnostics).toHaveLength(1)
      expect(diagnostics[0]).toMatchObject({
        code: "plugin.silent-failure",
        severity: "warning",
        pointId: "ai.upscale",
      })
    })

    it("records a diagnostic on the xAI mask-rejection path of ai.inpaint", async () => {
      clearAllPluginPointDiagnostics()
      mockUseSettingsStoreGetState.mockReturnValue({
        defaultProvider: "xai",
        providerSettings: {
          xai: {
            providerId: "xai",
            apiKey: "sk-xai",
            enabled: true,
            defaultModel: "grok-2-image",
          },
        },
        customProviders: [],
      })
      const api = createMediaAPI(testPluginId, {} as never)

      await expect(
        api.ai.inpaint(createTestImageData(), createTestImageData(), "replace the sky")
      ).rejects.toMatchObject({ code: "PROVIDER_ERROR" })

      const diagnostics = getPluginPointDiagnostics(testPluginId)
      expect(diagnostics).toHaveLength(1)
      expect(diagnostics[0]).toMatchObject({ pointId: "ai.inpaint" })
    })
  })
})
