import {
  __resetFileDocPoolForTesting,
  closeModel,
  configureFileDocPool,
  decodeFileUri,
  disposeAllPooledModels,
  enforceLruCap,
  getPoolStats,
  openModel,
  peekModel,
  type MonacoModelAdapter,
  type MonacoTextModel,
  type ReadFile,
} from "./file-doc-pool"

function makeFakeAdapter(): MonacoModelAdapter & {
  models: Map<string, MonacoTextModel>
} {
  const models = new Map<string, MonacoTextModel>()
  return {
    models,
    createModel({ uri, content, language }) {
      let value = content
      let disposed = false
      const model: MonacoTextModel = {
        uri,
        language,
        getValue: () => value,
        setValue: (v) => {
          value = v
        },
        dispose: () => {
          disposed = true
          models.delete(uri)
        },
        isDisposed: () => disposed,
      }
      models.set(uri, model)
      return model
    },
    getModel(uri) {
      return models.get(uri)
    },
  }
}

function makeFakeReadFile(map: Record<string, { content: string; language: string }>): ReadFile {
  return jest.fn(async (path: string) => {
    const entry = map[path]
    if (!entry) throw new Error(`No fixture for ${path}`)
    return entry
  })
}

describe("file-doc-pool", () => {
  beforeEach(() => __resetFileDocPoolForTesting())

  describe("configuration guard", () => {
    it("throws if openModel is called before configure", async () => {
      await expect(openModel("file:///foo")).rejects.toThrow(/not configured/i)
    })
  })

  describe("openModel", () => {
    it("creates a model on first touch and reuses it on subsequent ones", async () => {
      const adapter = makeFakeAdapter()
      const readFile = makeFakeReadFile({
        "/foo.js": { content: "const a = 1", language: "javascript" },
      })
      configureFileDocPool({ adapter, readFile })

      const m1 = await openModel("file:///foo.js")
      const m2 = await openModel("file:///foo.js")
      expect(m1).toBe(m2)
      expect(readFile).toHaveBeenCalledTimes(1)
      expect(m1.getValue()).toBe("const a = 1")
    })

    it("coalesces concurrent calls into a single read", async () => {
      const adapter = makeFakeAdapter()
      const readFile = jest.fn(
        async () =>
          new Promise<{ content: string; language: string }>((resolve) =>
            setTimeout(() => resolve({ content: "x", language: "javascript" }), 10)
          )
      )
      configureFileDocPool({ adapter, readFile })

      const [a, b] = await Promise.all([openModel("file:///bar.js"), openModel("file:///bar.js")])
      expect(a).toBe(b)
      expect(readFile).toHaveBeenCalledTimes(1)
    })

    it("recreates a model whose dispose() was called externally", async () => {
      const adapter = makeFakeAdapter()
      const readFile = makeFakeReadFile({
        "/x.js": { content: "x", language: "javascript" },
      })
      configureFileDocPool({ adapter, readFile })

      const m1 = await openModel("file:///x.js")
      m1.dispose()
      const m2 = await openModel("file:///x.js")
      expect(m2).not.toBe(m1)
      expect(readFile).toHaveBeenCalledTimes(2)
    })
  })

  describe("LRU eviction", () => {
    it("respects the configured cap", async () => {
      const adapter = makeFakeAdapter()
      const readFile = jest.fn(async () => ({ content: "x", language: "javascript" }))
      configureFileDocPool({ adapter, readFile, maxModels: 3 })

      const uris = ["a", "b", "c", "d"].map((n) => `file:///${n}.js`)
      const models: MonacoTextModel[] = []
      for (const uri of uris) {
        models.push(await openModel(uri))
      }
      const stats = getPoolStats()
      expect(stats.size).toBe(3)
      // First model (least recently used) should be disposed.
      expect(models[0]!.isDisposed()).toBe(true)
      expect(models[3]!.isDisposed()).toBe(false)
    })

    it("retouches a model to keep it alive under pressure", async () => {
      const adapter = makeFakeAdapter()
      const readFile = jest.fn(async () => ({ content: "x", language: "javascript" }))
      configureFileDocPool({ adapter, readFile, maxModels: 2 })

      // The pool's LRU sort uses `Date.now()`. On Windows the clock can
      // tick at ~15.6 ms; 1 ms waits between opens leave neighbours with
      // the same timestamp and the eviction loop falls back to insertion
      // order — exactly the wrong answer for "retouch keeps alive". Bump
      // each wait above one tick so each lastTouched is strictly newer.
      const TICK_MS = 20
      const a = await openModel("file:///a")
      await new Promise((r) => setTimeout(r, TICK_MS))
      const b = await openModel("file:///b")
      // Bump 'a' so it becomes the newer-touched of the two — now `b`
      // is the LRU victim on the next eviction.
      await new Promise((r) => setTimeout(r, TICK_MS))
      await openModel("file:///a")
      await new Promise((r) => setTimeout(r, TICK_MS))
      await openModel("file:///c")

      expect(a.isDisposed()).toBe(false)
      expect(b.isDisposed()).toBe(true)
    })

    it("enforceLruCap is idempotent below the cap", async () => {
      const adapter = makeFakeAdapter()
      const readFile = jest.fn(async () => ({ content: "x", language: "javascript" }))
      configureFileDocPool({ adapter, readFile, maxModels: 5 })
      await openModel("file:///a")
      enforceLruCap()
      enforceLruCap()
      expect(getPoolStats().size).toBe(1)
    })
  })

  describe("close / peek / disposeAll", () => {
    it("peekModel returns undefined when nothing pooled", () => {
      expect(peekModel("file:///nope")).toBeUndefined()
    })

    it("closeModel removes and disposes the entry", async () => {
      const adapter = makeFakeAdapter()
      const readFile = makeFakeReadFile({ "/x": { content: "x", language: "js" } })
      configureFileDocPool({ adapter, readFile })
      const m = await openModel("file:///x")
      expect(closeModel("file:///x")).toBe(true)
      expect(m.isDisposed()).toBe(true)
      expect(closeModel("file:///x")).toBe(false)
    })

    it("disposeAllPooledModels disposes everything", async () => {
      const adapter = makeFakeAdapter()
      const readFile = makeFakeReadFile({
        "/a": { content: "a", language: "js" },
        "/b": { content: "b", language: "js" },
      })
      configureFileDocPool({ adapter, readFile })
      const a = await openModel("file:///a")
      const b = await openModel("file:///b")
      disposeAllPooledModels()
      expect(a.isDisposed()).toBe(true)
      expect(b.isDisposed()).toBe(true)
      expect(getPoolStats().size).toBe(0)
    })
  })

  describe("decodeFileUri", () => {
    it("strips the scheme and decodes percent-encoded segments", () => {
      expect(decodeFileUri("file:///foo/bar%20baz.js")).toBe("/foo/bar baz.js")
    })

    it("handles Windows-style drive-letter URIs", () => {
      expect(decodeFileUri("file:///C:/Users/me/x.ts")).toBe("C:/Users/me/x.ts")
    })

    it("rejects non-file URIs", () => {
      expect(() => decodeFileUri("http://example.com")).toThrow(/Expected a file:\/\//)
    })
  })

  describe("dispose-time error handling", () => {
    it("survives a model whose dispose() throws", async () => {
      const adapter = makeFakeAdapter()
      // Override createModel to return a model that throws on dispose.
      const original = adapter.createModel.bind(adapter)
      adapter.createModel = (input) => {
        const m = original(input)
        m.dispose = () => {
          throw new Error("dispose boom")
        }
        return m
      }
      configureFileDocPool({
        adapter,
        readFile: makeFakeReadFile({ "/x": { content: "x", language: "js" } }),
      })
      await openModel("file:///x")
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
      try {
        disposeAllPooledModels()
        expect(warn).toHaveBeenCalled()
      } finally {
        warn.mockRestore()
      }
    })
  })
})
