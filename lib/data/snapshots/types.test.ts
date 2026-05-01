import {
  SNAPSHOT_FORMAT_VERSION,
  isLocalStorageSnapshot,
  makeSnapshot,
  parsePersistEnvelope,
  type LocalStorageSnapshot,
} from "./types"

describe("snapshot types", () => {
  describe("parsePersistEnvelope", () => {
    it("parses a valid Zustand envelope", () => {
      const env = parsePersistEnvelope(JSON.stringify({ state: { count: 1 }, version: 2 }))
      expect(env).toEqual({ state: { count: 1 }, version: 2 })
    })

    it("returns null on non-JSON input", () => {
      expect(parsePersistEnvelope("not json")).toBeNull()
    })

    it("returns null on JSON missing state", () => {
      expect(parsePersistEnvelope(JSON.stringify({ version: 1 }))).toBeNull()
    })

    it("returns null on JSON with non-number version", () => {
      expect(parsePersistEnvelope(JSON.stringify({ state: {}, version: "1" }))).toBeNull()
    })

    it("returns null on null root", () => {
      expect(parsePersistEnvelope("null")).toBeNull()
    })
  })

  describe("makeSnapshot", () => {
    it("populates all required fields", () => {
      const snap = makeSnapshot("cognia-test", { state: { x: 1 }, version: 5 })
      expect(snap.key).toBe("cognia-test")
      expect(snap.storeVersion).toBe(5)
      expect(snap.snapshotFormatVersion).toBe(SNAPSHOT_FORMAT_VERSION)
      expect(snap.raw).toEqual({ state: { x: 1 }, version: 5 })
      expect(typeof snap.capturedAt).toBe("string")
      expect(() => new Date(snap.capturedAt).toISOString()).not.toThrow()
    })
  })

  describe("isLocalStorageSnapshot", () => {
    const valid: LocalStorageSnapshot = makeSnapshot("k", { state: {}, version: 0 })

    it("accepts a well-formed snapshot", () => {
      expect(isLocalStorageSnapshot(valid)).toBe(true)
    })

    it("rejects null and primitives", () => {
      expect(isLocalStorageSnapshot(null)).toBe(false)
      expect(isLocalStorageSnapshot(undefined)).toBe(false)
      expect(isLocalStorageSnapshot("string")).toBe(false)
      expect(isLocalStorageSnapshot(42)).toBe(false)
    })

    it("rejects wrong format version", () => {
      expect(isLocalStorageSnapshot({ ...valid, snapshotFormatVersion: 99 })).toBe(false)
    })

    it("rejects missing raw", () => {
      const broken = { ...valid, raw: undefined as unknown }
      expect(isLocalStorageSnapshot(broken)).toBe(false)
    })

    it("rejects raw without numeric version", () => {
      const broken = { ...valid, raw: { state: {}, version: "0" } } as unknown
      expect(isLocalStorageSnapshot(broken)).toBe(false)
    })

    it("rejects missing capturedAt", () => {
      const broken = { ...valid, capturedAt: undefined as unknown }
      expect(isLocalStorageSnapshot(broken)).toBe(false)
    })

    it("rejects missing key", () => {
      const broken = { ...valid, key: 0 as unknown }
      expect(isLocalStorageSnapshot(broken)).toBe(false)
    })
  })
})
