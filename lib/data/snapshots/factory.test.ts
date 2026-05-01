import { applyMergeStrategy, createGenericSnapshotModule } from "./factory"
import { createMemoryStorage } from "./helpers"
import { makeSnapshot, type SnapshotEnv } from "./types"

describe("createGenericSnapshotModule", () => {
  const KEY = "cognia-test-store"

  function make(opts: Partial<Parameters<typeof createGenericSnapshotModule>[0]> = {}) {
    return createGenericSnapshotModule({
      key: KEY,
      labelKey: "test",
      exposeAsDomain: true,
      ...opts,
    })
  }

  function envWith(initial?: Record<string, string>, warn = jest.fn()) {
    const { storage, data } = createMemoryStorage(initial)
    const env: SnapshotEnv = { storage, warn }
    return { env, data, warn }
  }

  describe("read", () => {
    it("returns null when key missing", () => {
      const { env } = envWith()
      expect(make().read(env)).toBeNull()
    })

    it("returns null on parse error and warns", () => {
      const { env, warn } = envWith({ [KEY]: "garbage" })
      expect(make().read(env)).toBeNull()
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("corrupt envelope"),
        expect.any(Object)
      )
    })

    it("returns null when storage.getItem throws", () => {
      const env: SnapshotEnv = {
        storage: {
          getItem: () => {
            throw new Error("locked")
          },
          setItem: () => undefined,
          removeItem: () => undefined,
        },
      }
      expect(make().read(env)).toBeNull()
    })

    it("captures a valid envelope", () => {
      const { env } = envWith({
        [KEY]: JSON.stringify({ state: { a: 1 }, version: 3 }),
      })
      const snap = make().read(env)
      expect(snap?.key).toBe(KEY)
      expect(snap?.storeVersion).toBe(3)
      expect(snap?.raw.state).toEqual({ a: 1 })
    })

    it("applies prepareState before snapshot capture", () => {
      const { env } = envWith({
        [KEY]: JSON.stringify({ state: { secret: "a", keep: "b" }, version: 0 }),
      })
      const mod = make({
        prepareState: (s) => {
          const obj = s as { secret: string; keep: string }
          return { ...obj, secret: "***" }
        },
      })
      const snap = mod.read(env)
      expect((snap?.raw.state as { secret: string }).secret).toBe("***")
      expect((snap?.raw.state as { keep: string }).keep).toBe("b")
    })

    it("warns on oversize payload but still returns snapshot", () => {
      const big = "x".repeat(2_000)
      const { env, warn } = envWith({
        [KEY]: JSON.stringify({ state: { big }, version: 0 }),
      })
      const snap = make({ maxBytesWarn: 100 }).read(env)
      expect(snap).not.toBeNull()
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("exceeds"),
        expect.objectContaining({ bytes: expect.any(Number) })
      )
    })
  })

  describe("write", () => {
    it("overwrites by default", () => {
      const { env, data } = envWith({ [KEY]: "old" })
      const snap = makeSnapshot(KEY, { state: { z: 1 }, version: 0 })
      make().write(snap, "overwrite", env)
      expect(data.get(KEY)).toContain('"z":1')
    })

    it("respects skip when an existing entry is present", () => {
      const { env, data } = envWith({ [KEY]: '{"state":{"old":1},"version":0}' })
      const snap = makeSnapshot(KEY, { state: { fresh: true }, version: 0 })
      make().write(snap, "skip", env)
      expect(data.get(KEY)).toBe('{"state":{"old":1},"version":0}')
    })

    it("writes when skip but no existing entry", () => {
      const { env, data } = envWith()
      const snap = makeSnapshot(KEY, { state: { n: 1 }, version: 0 })
      make().write(snap, "skip", env)
      expect(data.get(KEY)).toContain('"n":1')
    })

    it("treats duplicate as overwrite for Zustand stores", () => {
      const { env, data } = envWith({ [KEY]: "old" })
      const snap = makeSnapshot(KEY, { state: { dup: true }, version: 0 })
      make().write(snap, "duplicate", env)
      expect(data.get(KEY)).toContain('"dup":true')
    })

    it("ignores mis-keyed snapshots", () => {
      const { env, data } = envWith()
      const snap = makeSnapshot("other-key", { state: {}, version: 0 })
      make().write(snap, "overwrite", env)
      expect(data.size).toBe(0)
    })

    it("ignores invalid snapshot payloads", () => {
      const { env, data } = envWith()
      // @ts-expect-error - intentionally invalid input
      make().write({ key: KEY, foo: "bar" }, "overwrite", env)
      expect(data.size).toBe(0)
    })

    it("falls back gracefully when getItem during write throws", () => {
      const env: SnapshotEnv = {
        storage: {
          getItem: () => {
            throw new Error("boom")
          },
          setItem: jest.fn(),
          removeItem: () => undefined,
        },
      }
      const snap = makeSnapshot(KEY, { state: { y: 1 }, version: 0 })
      make().write(snap, "overwrite", env)
      expect(env.storage.setItem).toHaveBeenCalled()
    })
  })

  describe("applyMergeStrategy", () => {
    it("keeps existing on skip", () => {
      expect(applyMergeStrategy("old", "new", "skip")).toBe("old")
    })

    it("writes new on overwrite", () => {
      expect(applyMergeStrategy("old", "new", "overwrite")).toBe("new")
    })

    it("writes new when no existing", () => {
      expect(applyMergeStrategy(null, "new", "skip")).toBe("new")
    })
  })
})
