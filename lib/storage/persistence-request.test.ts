import { requestPersistentStorage, isStoragePersisted } from "./persistence-request"

const original = (globalThis.navigator as Navigator | undefined)?.storage

function setStorage(storage: unknown) {
  Object.defineProperty(globalThis.navigator, "storage", {
    value: storage,
    configurable: true,
  })
}

afterEach(() => {
  setStorage(original)
})

describe("requestPersistentStorage", () => {
  it("returns 'persisted' when already persisted without calling persist()", async () => {
    const persist = jest.fn(async () => false)
    setStorage({ persisted: async () => true, persist })
    expect(await requestPersistentStorage()).toBe("persisted")
    expect(persist).not.toHaveBeenCalled()
  })

  it("returns 'persisted' when persist() is granted", async () => {
    setStorage({ persisted: async () => false, persist: async () => true })
    expect(await requestPersistentStorage()).toBe("persisted")
  })

  it("returns 'denied' when persist() is refused", async () => {
    setStorage({ persisted: async () => false, persist: async () => false })
    expect(await requestPersistentStorage()).toBe("denied")
  })

  it("returns 'unsupported' when the storage API is absent", async () => {
    setStorage(undefined)
    expect(await requestPersistentStorage()).toBe("unsupported")
  })

  it("returns 'unsupported' when persist is not a function", async () => {
    setStorage({ persisted: async () => false })
    expect(await requestPersistentStorage()).toBe("unsupported")
  })

  it("never throws — maps an exploding API to 'unsupported'", async () => {
    setStorage({
      persisted: async () => {
        throw new Error("blocked")
      },
      persist: async () => true,
    })
    expect(await requestPersistentStorage()).toBe("unsupported")
  })
})

describe("isStoragePersisted", () => {
  it("reflects the persisted state", async () => {
    setStorage({ persisted: async () => true })
    expect(await isStoragePersisted()).toBe(true)
    setStorage({ persisted: async () => false })
    expect(await isStoragePersisted()).toBe(false)
  })

  it("returns false when the API is missing", async () => {
    setStorage({})
    expect(await isStoragePersisted()).toBe(false)
  })

  it("returns false when persisted() throws", async () => {
    setStorage({
      persisted: async () => {
        throw new Error("nope")
      },
    })
    expect(await isStoragePersisted()).toBe(false)
  })
})
