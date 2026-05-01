import {
  createMemoryStorage,
  migrateAllSnapshots,
  readAllSnapshots,
  restoreFromPreSnap,
  writeAllSnapshots,
} from "./helpers"
import { makeSnapshot, type SnapshotEnv, type SnapshotModule } from "./types"

function makeModule(key: string, overrides: Partial<SnapshotModule> = {}): SnapshotModule {
  return {
    key,
    labelKey: key,
    exposeAsDomain: false,
    read(env) {
      const raw = env.storage.getItem(key)
      if (!raw) return null
      try {
        const parsed = JSON.parse(raw) as { state: unknown; version: number }
        return makeSnapshot(key, parsed)
      } catch {
        return null
      }
    },
    write(snap, _strategy, env) {
      env.storage.setItem(key, JSON.stringify(snap.raw))
    },
    ...overrides,
  }
}

describe("snapshot helpers", () => {
  describe("createMemoryStorage", () => {
    it("round-trips set/get/remove", () => {
      const { storage } = createMemoryStorage()
      expect(storage.getItem("a")).toBeNull()
      storage.setItem("a", "v")
      expect(storage.getItem("a")).toBe("v")
      storage.removeItem("a")
      expect(storage.getItem("a")).toBeNull()
    })

    it("seeds initial data", () => {
      const { storage } = createMemoryStorage({ a: "1" })
      expect(storage.getItem("a")).toBe("1")
    })
  })

  describe("readAllSnapshots", () => {
    it("captures present keys, lists missing ones", () => {
      const a = makeModule("a")
      const b = makeModule("b")
      const { storage } = createMemoryStorage({
        a: JSON.stringify({ state: { x: 1 }, version: 0 }),
      })
      const env: SnapshotEnv = { storage }
      const result = readAllSnapshots([a, b], env)
      expect(result.snapshots.a?.raw.state).toEqual({ x: 1 })
      expect(result.missing).toEqual(["b"])
    })

    it("captures errors from a misbehaving read into missing[] and warns", () => {
      const warn = jest.fn()
      const broken: SnapshotModule = {
        ...makeModule("broken"),
        read() {
          throw new Error("boom")
        },
      }
      const { storage } = createMemoryStorage()
      const env: SnapshotEnv = { storage, warn }
      const result = readAllSnapshots([broken], env)
      expect(result.missing).toEqual(["broken"])
      expect(warn).toHaveBeenCalledWith(
        "snapshot.read failed for broken",
        expect.objectContaining({ error: "boom" })
      )
    })

    it("treats non-Error throws as strings", () => {
      const broken: SnapshotModule = {
        ...makeModule("broken"),
        read() {
          throw "string-error"
        },
      }
      const warn = jest.fn()
      const { storage } = createMemoryStorage()
      const env: SnapshotEnv = { storage, warn }
      const result = readAllSnapshots([broken], env)
      expect(result.missing).toEqual(["broken"])
      expect(warn).toHaveBeenCalledWith(
        "snapshot.read failed for broken",
        expect.objectContaining({ error: "string-error" })
      )
    })
  })

  describe("writeAllSnapshots", () => {
    it("writes via matching modules and skips unknown keys", () => {
      const a = makeModule("a")
      const { storage, data } = createMemoryStorage()
      const env: SnapshotEnv = { storage }
      const result = writeAllSnapshots(
        [a],
        {
          a: makeSnapshot("a", { state: { x: 7 }, version: 0 }),
          b: makeSnapshot("b", { state: { y: 1 }, version: 0 }),
        },
        "overwrite",
        env
      )
      expect(result.written).toEqual(["a"])
      expect(result.skipped).toEqual(["b"])
      expect(data.get("a")).toContain('"x":7')
    })

    it("captures per-module write errors", () => {
      const broken: SnapshotModule = {
        ...makeModule("broken"),
        write() {
          throw new Error("fail-write")
        },
      }
      const { storage } = createMemoryStorage()
      const env: SnapshotEnv = { storage }
      const result = writeAllSnapshots(
        [broken],
        { broken: makeSnapshot("broken", { state: {}, version: 0 }) },
        "overwrite",
        env
      )
      expect(result.errors).toEqual([{ key: "broken", error: "fail-write" }])
    })

    it("handles non-Error write throws", () => {
      const broken: SnapshotModule = {
        ...makeModule("broken"),
        write() {
          throw "string"
        },
      }
      const { storage } = createMemoryStorage()
      const env: SnapshotEnv = { storage }
      const result = writeAllSnapshots(
        [broken],
        { broken: makeSnapshot("broken", { state: {}, version: 0 }) },
        "overwrite",
        env
      )
      expect(result.errors).toEqual([{ key: "broken", error: "string" }])
    })
  })

  describe("restoreFromPreSnap", () => {
    it("rewrites pre-snapshot keys and clears keys not in pre-snapshot", () => {
      const a = makeModule("a")
      const b = makeModule("b")
      const { storage, data } = createMemoryStorage({
        a: "stale-current",
        b: "added-after-tx",
      })
      const env: SnapshotEnv = { storage }
      const preSnap = {
        a: makeSnapshot("a", { state: { restored: true }, version: 0 }),
      }
      const result = restoreFromPreSnap([a, b], preSnap, env)
      expect(result.restored).toEqual(["a"])
      expect(result.cleared).toEqual(["b"])
      expect(data.get("a")).toContain("restored")
      expect(data.has("b")).toBe(false)
    })

    it("respects removeMissingKeys=false", () => {
      const b = makeModule("b")
      const { storage, data } = createMemoryStorage({ b: "keep-me" })
      const env: SnapshotEnv = { storage }
      const result = restoreFromPreSnap([b], {}, env, false)
      expect(result.cleared).toEqual([])
      expect(data.get("b")).toBe("keep-me")
    })

    it("warns when restore-write throws", () => {
      const warn = jest.fn()
      const a: SnapshotModule = {
        ...makeModule("a"),
        write() {
          throw new Error("write-failed")
        },
      }
      const { storage } = createMemoryStorage()
      const env: SnapshotEnv = { storage, warn }
      restoreFromPreSnap([a], { a: makeSnapshot("a", { state: {}, version: 0 }) }, env)
      expect(warn).toHaveBeenCalledWith(
        "snapshot.restore failed for a",
        expect.objectContaining({ error: "write-failed" })
      )
    })

    it("warns when storage.removeItem throws during clear", () => {
      const warn = jest.fn()
      const a = makeModule("a")
      const env: SnapshotEnv = {
        warn,
        storage: {
          getItem: () => null,
          setItem: () => undefined,
          removeItem: () => {
            throw new Error("rm-failed")
          },
        },
      }
      restoreFromPreSnap([a], {}, env)
      expect(warn).toHaveBeenCalledWith(
        "snapshot.clear failed for a",
        expect.objectContaining({ error: "rm-failed" })
      )
    })
  })

  describe("migrateAllSnapshots", () => {
    it("calls migrate when storeVersion mismatches", () => {
      const migrated = jest.fn((snap) => snap)
      const m: SnapshotModule = {
        ...makeModule("a"),
        migrate: migrated,
      }
      const out = migrateAllSnapshots(
        [m],
        { a: makeSnapshot("a", { state: {}, version: 1 }) },
        { a: 2 }
      )
      expect(migrated).toHaveBeenCalledTimes(1)
      expect(out.a).toBeDefined()
    })

    it("skips migrate when versions match", () => {
      const migrated = jest.fn((snap) => snap)
      const m: SnapshotModule = {
        ...makeModule("a"),
        migrate: migrated,
      }
      migrateAllSnapshots([m], { a: makeSnapshot("a", { state: {}, version: 1 }) }, { a: 1 })
      expect(migrated).not.toHaveBeenCalled()
    })

    it("passes through when no migrate hook", () => {
      const m = makeModule("a")
      const snap = makeSnapshot("a", { state: { z: 1 }, version: 0 })
      const out = migrateAllSnapshots([m], { a: snap }, { a: 5 })
      expect(out.a).toBe(snap)
    })

    it("ignores keys with no module registered", () => {
      const snap = makeSnapshot("ghost", { state: {}, version: 0 })
      const out = migrateAllSnapshots([], { ghost: snap }, { ghost: 1 })
      expect(out.ghost).toBe(snap)
    })
  })
})
