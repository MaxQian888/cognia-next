// Runs in the `node` project (no jsdom docblock) on purpose: the branch that
// regressed on Node 26 is the one with NO `window`, and only the node env has
// that natively — under jsdom, `window` is non-configurable and cannot be
// removed or redefined at all.
import { resolvePersistStorage, persistLocalStorage } from "./persist-storage"

type WindowHost = { window?: { localStorage?: unknown } }

/** Install a minimal browser-like `window` for the duration of `run`. */
function withWindow(localStorage: unknown, run: () => void): void {
  const host = globalThis as unknown as WindowHost
  const had = "window" in host
  const previous = host.window
  host.window = localStorage === undefined ? {} : { localStorage }
  try {
    run()
  } finally {
    if (had) host.window = previous
    else delete host.window
  }
}

describe("resolvePersistStorage", () => {
  it("returns inert storage when there is no window (SSR / CLI / sidecar / headless)", () => {
    expect(typeof window).toBe("undefined")
    const storage = resolvePersistStorage()
    expect(storage.getItem("anything")).toBeNull()
    expect(() => storage.setItem("a", "b")).not.toThrow()
    expect(() => storage.removeItem("a")).not.toThrow()
  })

  it("returns the real localStorage when the browser provides one", () => {
    const real = { getItem: jest.fn(() => null), setItem: jest.fn(), removeItem: jest.fn() }
    withWindow(real, () => {
      expect(resolvePersistStorage()).toBe(real)
    })
  })

  it("falls back to inert storage when window has no localStorage", () => {
    withWindow(undefined, () => {
      expect(resolvePersistStorage().getItem("anything")).toBeNull()
    })
  })

  it("falls back to inert storage when reading window.localStorage throws (blocked cookies)", () => {
    const host = globalThis as unknown as WindowHost
    const had = "window" in host
    const previous = host.window
    host.window = Object.defineProperty({}, "localStorage", {
      get() {
        throw new Error("SecurityError: storage is denied")
      },
    })
    try {
      expect(resolvePersistStorage().getItem("anything")).toBeNull()
    } finally {
      if (had) host.window = previous
      else delete host.window
    }
  })

  it("persistLocalStorage yields a JSON storage that round-trips through localStorage", () => {
    const backing = new Map<string, string>()
    const real = {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => void backing.set(k, v),
      removeItem: (k: string) => void backing.delete(k),
    }
    withWindow(real, () => {
      const storage = persistLocalStorage()
      storage?.setItem("cognia.persist-json", { state: { a: 1 }, version: 0 })
      expect(storage?.getItem("cognia.persist-json")).toEqual({ state: { a: 1 }, version: 0 })
      storage?.removeItem("cognia.persist-json")
      expect(storage?.getItem("cognia.persist-json")).toBeNull()
    })
  })

  it("persistLocalStorage is inert (never throws) with no window — the Node 26 regression", () => {
    const storage = persistLocalStorage()
    expect(() => storage?.setItem("k", { state: {}, version: 0 })).not.toThrow()
    expect(storage?.getItem("k")).toBeNull()
  })
})
