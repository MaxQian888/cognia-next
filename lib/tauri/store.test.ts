// Provide a per-test mock for LazyStore so we can control success vs. failure.
const lazyStoreInstances: MockLazyStore[] = []

class MockLazyStore {
  public getMock = jest.fn()
  public setMock = jest.fn()
  public deleteMock = jest.fn()
  public saveMock = jest.fn()
  public file: string
  public options: unknown

  constructor(file: string, options?: unknown) {
    this.file = file
    this.options = options
    this.getMock.mockResolvedValue(undefined)
    this.setMock.mockResolvedValue(undefined)
    this.deleteMock.mockResolvedValue(undefined)
    this.saveMock.mockResolvedValue(undefined)
    lazyStoreInstances.push(this)
  }

  get<T>(key: string) {
    return this.getMock(key) as Promise<T | undefined>
  }
  set<T>(key: string, value: T) {
    return this.setMock(key, value) as Promise<void>
  }
  delete(key: string) {
    return this.deleteMock(key) as Promise<boolean>
  }
  save() {
    return this.saveMock() as Promise<void>
  }
}

jest.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: MockLazyStore,
}))

const TAURI_KEY = "__TAURI_INTERNALS__"

function setTauri(on: boolean) {
  if (on) (window as unknown as Record<string, unknown>)[TAURI_KEY] = {}
  else delete (window as unknown as Record<string, unknown>)[TAURI_KEY]
}

describe("lib/tauri/store", () => {
  let warnSpy: jest.SpyInstance

  beforeEach(() => {
    jest.resetModules()
    lazyStoreInstances.length = 0
    setTauri(false)
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {})
  })

  afterEach(() => {
    setTauri(false)
    warnSpy.mockRestore()
  })

  describe("outside Tauri", () => {
    it("getPref returns null without instantiating a store", async () => {
      const { getPref } = await import("./store")
      await expect(getPref("k")).resolves.toBeNull()
      expect(lazyStoreInstances).toHaveLength(0)
    })

    it("setPref is a no-op", async () => {
      const { setPref } = await import("./store")
      await expect(setPref("k", 1)).resolves.toBeUndefined()
      expect(lazyStoreInstances).toHaveLength(0)
    })

    it("deletePref is a no-op", async () => {
      const { deletePref } = await import("./store")
      await expect(deletePref("k")).resolves.toBeUndefined()
      expect(lazyStoreInstances).toHaveLength(0)
    })

    it("flushPrefs is a no-op", async () => {
      const { flushPrefs } = await import("./store")
      await expect(flushPrefs()).resolves.toBeUndefined()
      expect(lazyStoreInstances).toHaveLength(0)
    })
  })

  describe("inside Tauri", () => {
    it("getPref returns the stored value when present", async () => {
      setTauri(true)
      const { getPref } = await import("./store")
      // Trigger lazy instantiation
      await getPref("first")
      const store = lazyStoreInstances[0]
      store.getMock.mockResolvedValueOnce("hello")
      await expect(getPref<string>("k")).resolves.toBe("hello")
      expect(store.getMock).toHaveBeenLastCalledWith("k")
    })

    it("getPref normalizes undefined to null", async () => {
      setTauri(true)
      const { getPref } = await import("./store")
      await getPref("seed")
      const store = lazyStoreInstances[0]
      store.getMock.mockResolvedValueOnce(undefined)
      await expect(getPref("k")).resolves.toBeNull()
    })

    it("getPref logs and returns null when get rejects", async () => {
      setTauri(true)
      const { getPref } = await import("./store")
      await getPref("seed")
      const store = lazyStoreInstances[0]
      store.getMock.mockRejectedValueOnce(new Error("get boom"))
      await expect(getPref("k")).resolves.toBeNull()
      expect(warnSpy).toHaveBeenCalledWith("store.get(k) failed", expect.any(Error))
    })

    it("setPref calls store.set", async () => {
      setTauri(true)
      const { setPref } = await import("./store")
      await setPref("k", 42)
      const store = lazyStoreInstances[0]
      expect(store.setMock).toHaveBeenCalledWith("k", 42)
    })

    it("setPref logs when store.set rejects", async () => {
      setTauri(true)
      const { setPref } = await import("./store")
      await setPref("seed", 1)
      const store = lazyStoreInstances[0]
      store.setMock.mockRejectedValueOnce(new Error("set boom"))
      await expect(setPref("k", 2)).resolves.toBeUndefined()
      expect(warnSpy).toHaveBeenCalledWith("store.set(k) failed", expect.any(Error))
    })

    it("deletePref calls store.delete", async () => {
      setTauri(true)
      const { deletePref } = await import("./store")
      await deletePref("k")
      const store = lazyStoreInstances[0]
      expect(store.deleteMock).toHaveBeenCalledWith("k")
    })

    it("deletePref logs when store.delete rejects", async () => {
      setTauri(true)
      const { deletePref } = await import("./store")
      await deletePref("seed")
      const store = lazyStoreInstances[0]
      store.deleteMock.mockRejectedValueOnce(new Error("del boom"))
      await expect(deletePref("k")).resolves.toBeUndefined()
      expect(warnSpy).toHaveBeenCalledWith("store.delete(k) failed", expect.any(Error))
    })

    it("flushPrefs calls store.save", async () => {
      setTauri(true)
      const { flushPrefs } = await import("./store")
      await flushPrefs()
      const store = lazyStoreInstances[0]
      expect(store.saveMock).toHaveBeenCalledTimes(1)
    })

    it("flushPrefs logs when store.save rejects", async () => {
      setTauri(true)
      const { flushPrefs } = await import("./store")
      await flushPrefs()
      const store = lazyStoreInstances[0]
      store.saveMock.mockRejectedValueOnce(new Error("save boom"))
      await expect(flushPrefs()).resolves.toBeUndefined()
      expect(warnSpy).toHaveBeenCalledWith("store.save failed", expect.any(Error))
    })

    it("instantiates exactly one shared LazyStore (cached) per module load", async () => {
      setTauri(true)
      const mod = await import("./store")
      await mod.getPref("a")
      await mod.setPref("b", 1)
      await mod.deletePref("c")
      await mod.flushPrefs()
      expect(lazyStoreInstances).toHaveLength(1)
      expect(lazyStoreInstances[0].file).toBe("cognia.store.json")
      expect(lazyStoreInstances[0].options).toEqual({ autoSave: true, defaults: {} })
    })
  })
})
