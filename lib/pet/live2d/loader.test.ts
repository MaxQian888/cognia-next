import { createLive2dLoader, type EngineModule } from "./loader"
import type { Live2DManifest, ModelFileEntry } from "./types"

// Stub the engine subpath so the default `importEngine` can run without pulling
// the real (heavy, ESM) engine into the test graph.
const mockFrom = jest.fn(async () => ({ destroy: jest.fn() }))
jest.mock(
  "untitled-pixi-live2d-engine/cubism",
  () => ({
    Live2DModel: { from: mockFrom },
    CubismModelSettings: class {
      constructor(public json: Record<string, unknown> & { url: string }) {}
      replaceFiles(replacer: (file: string, path: string) => string): void {
        replacer("Char.moc3", "Char.moc3")
      }
    },
    MotionPriority: { NONE: 0, IDLE: 1, NORMAL: 2, FORCE: 3 },
  }),
  { virtual: true }
)

const MANIFEST: Live2DManifest = {
  kind: "modern",
  settingsPath: "model/Char.model3.json",
  mocPath: "model/Char.moc3",
  texturePaths: ["model/tex/t0.png"],
  motionGroups: ["Idle"],
  expressionIds: [],
}

function entries(): ModelFileEntry[] {
  return [
    {
      path: "model/Char.model3.json",
      blob: new Blob([
        JSON.stringify({ FileReferences: { Moc: "Char.moc3", Textures: ["tex/t0.png"] } }),
      ]),
    },
    { path: "model/Char.moc3", blob: new Blob(["moc"]) },
    { path: "model/tex/t0.png", blob: new Blob(["png"]) },
  ]
}

type UrlStub = {
  createObjectURL?: (b: Blob) => string
  revokeObjectURL?: (url: string) => void
}

/** Install object-URL stubs on the global URL (jsdom lacks them). */
function installUrlStubs(create: (b: Blob) => string, revoke: (url: string) => void): () => void {
  const u = URL as unknown as UrlStub
  const hadCreate = "createObjectURL" in u
  const hadRevoke = "revokeObjectURL" in u
  u.createObjectURL = create
  u.revokeObjectURL = revoke
  return () => {
    if (!hadCreate) delete u.createObjectURL
    if (!hadRevoke) delete u.revokeObjectURL
  }
}

function fakeEngine(overrides: Partial<EngineModule> = {}): {
  engine: EngineModule
  modelDestroy: jest.Mock
  replaced: Array<[string, string]>
} {
  const replaced: Array<[string, string]> = []
  const modelDestroy = jest.fn()
  const engine: EngineModule = {
    CubismModelSettings: class {
      constructor(public json: Record<string, unknown> & { url: string }) {}
      replaceFiles(replacer: (file: string, path: string) => string): void {
        // The engine calls replacer for each referenced file with the path
        // relative to the settings directory.
        replaced.push(["Char.moc3", replacer("Char.moc3", "Char.moc3")])
        replaced.push(["tex/t0.png", replacer("tex/t0.png", "tex/t0.png")])
        // An unknown file should fall back to the original name.
        replaced.push(["ghost.png", replacer("ghost.png", "ghost.png")])
      }
    } as unknown as EngineModule["CubismModelSettings"],
    Live2DModel: {
      from: jest.fn(async () => ({ destroy: modelDestroy })),
    },
    MotionPriority: { NONE: 0, IDLE: 1, NORMAL: 2, FORCE: 3 },
    ...overrides,
  }
  return { engine, modelDestroy, replaced }
}

describe("createLive2dLoader", () => {
  it("returns coreMissing when the core can't be loaded", async () => {
    const loader = createLive2dLoader({
      ensureCore: async () => false,
      importEngine: async () => fakeEngine().engine,
    })
    const result = await loader.load({ manifest: MANIFEST, entries: entries() })
    expect(result).toEqual({ ok: false, code: "coreMissing" })
  })

  it("returns engineFailed when the engine import rejects", async () => {
    const loader = createLive2dLoader({
      ensureCore: async () => true,
      importEngine: async () => {
        throw new Error("import boom")
      },
    })
    const result = await loader.load({ manifest: MANIFEST, entries: entries() })
    expect(result).toEqual({ ok: false, code: "engineFailed" })
  })

  it("returns modelFailed when the settings entry is missing", async () => {
    const { engine } = fakeEngine()
    const loader = createLive2dLoader({
      ensureCore: async () => true,
      importEngine: async () => engine,
    })
    const result = await loader.load({
      manifest: MANIFEST,
      entries: entries().filter((e) => e.path !== MANIFEST.settingsPath),
    })
    expect(result).toEqual({ ok: false, code: "modelFailed" })
  })

  it("returns modelFailed and revokes URLs when Live2DModel.from throws", async () => {
    const revoke = jest.fn()
    const restore = installUrlStubs((b) => `blob:${(b as Blob).size}`, revoke)
    const { engine } = fakeEngine({
      Live2DModel: {
        from: jest.fn(async () => {
          throw new Error("model boom")
        }),
      },
    })
    const loader = createLive2dLoader({
      ensureCore: async () => true,
      importEngine: async () => engine,
    })
    const result = await loader.load({ manifest: MANIFEST, entries: entries() })
    expect(result).toEqual({ ok: false, code: "modelFailed" })
    expect(revoke).toHaveBeenCalled()
    restore()
  })

  it("loads the model, rewrites referenced files to blob URLs, and disposes", async () => {
    const urls: string[] = []
    const createSpy = jest.fn((b: Blob) => {
      const url = `blob:${urls.length}-${b.size}`
      urls.push(url)
      return url
    })
    const revokeSpy = jest.fn()
    const restore = installUrlStubs(createSpy, revokeSpy)

    const { engine, modelDestroy, replaced } = fakeEngine()
    const loader = createLive2dLoader({
      ensureCore: async () => true,
      importEngine: async () => engine,
    })
    const result = await loader.load({ manifest: MANIFEST, entries: entries() })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    // Known files were rewritten to blob URLs; the unknown one kept its name.
    const map = new Map(replaced)
    expect(map.get("Char.moc3")).toMatch(/^blob:/)
    expect(map.get("tex/t0.png")).toMatch(/^blob:/)
    expect(map.get("ghost.png")).toBe("ghost.png")

    expect(engine.Live2DModel.from).toHaveBeenCalledTimes(1)
    expect(createSpy).toHaveBeenCalledTimes(3)

    result.dispose()
    expect(revokeSpy).toHaveBeenCalledTimes(3)
    expect(modelDestroy).toHaveBeenCalledTimes(1)

    restore()
  })

  it("disposes safely when the loaded model has no destroy method", async () => {
    const revoke = jest.fn()
    const restore = installUrlStubs((b) => `blob:${(b as Blob).size}`, revoke)
    const { engine } = fakeEngine({
      Live2DModel: { from: jest.fn(async () => ({})) },
    })
    const loader = createLive2dLoader({
      ensureCore: async () => true,
      importEngine: async () => engine,
    })
    const result = await loader.load({ manifest: MANIFEST, entries: entries() })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(() => result.dispose()).not.toThrow()
    expect(revoke).toHaveBeenCalled()
    restore()
  })

  it("uses the default deps (ensureCore + dynamic engine import) when none injected", async () => {
    // Pre-set the core global so the real default ensureCore resolves true
    // synchronously; the engine subpath is jest.mock'd, so the default
    // `importEngine` dynamic import is exercised safely.
    ;(window as unknown as { Live2DCubismCore?: unknown }).Live2DCubismCore = {}
    const restore = installUrlStubs((b) => `blob:${(b as Blob).size}`, jest.fn())
    const loader = createLive2dLoader()
    const result = await loader.load({ manifest: MANIFEST, entries: entries() })
    expect(result.ok).toBe(true)
    expect(mockFrom).toHaveBeenCalled()
    restore()
    delete (window as unknown as { Live2DCubismCore?: unknown }).Live2DCubismCore
  })
})
