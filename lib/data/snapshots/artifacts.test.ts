import {
  ARTIFACTS_LABEL_KEY,
  ARTIFACTS_PERSIST_KEY,
  ARTIFACTS_SIZE_WARN_BYTES,
  artifactsSnapshot,
} from "./artifacts"
import { createMemoryStorage } from "./helpers"
import type { SnapshotEnv } from "./types"

describe("artifactsSnapshot", () => {
  it("uses the documented persist + label keys", () => {
    expect(artifactsSnapshot.key).toBe(ARTIFACTS_PERSIST_KEY)
    expect(artifactsSnapshot.labelKey).toBe(ARTIFACTS_LABEL_KEY)
    // False since schema v206: the "Artifacts" transfer domain reads the Dexie
    // tables, and this blob holds only the dock's preferences.
    expect(artifactsSnapshot.exposeAsDomain).toBe(false)
    expect(ARTIFACTS_SIZE_WARN_BYTES).toBe(2_000_000)
  })

  it("captures a small payload silently", () => {
    const warn = jest.fn()
    const { storage } = createMemoryStorage({
      [ARTIFACTS_PERSIST_KEY]: JSON.stringify({ state: {}, version: 3 }),
    })
    const env: SnapshotEnv = { storage, warn }
    artifactsSnapshot.read(env)
    expect(warn).not.toHaveBeenCalled()
  })

  it("warns once the persisted blob exceeds the threshold", () => {
    const big = "y".repeat(ARTIFACTS_SIZE_WARN_BYTES + 100)
    const warn = jest.fn()
    const { storage } = createMemoryStorage({
      [ARTIFACTS_PERSIST_KEY]: JSON.stringify({ state: { huge: big }, version: 3 }),
    })
    const env: SnapshotEnv = { storage, warn }
    const snap = artifactsSnapshot.read(env)
    expect(snap).not.toBeNull()
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("exceeds"),
      expect.objectContaining({ bytes: expect.any(Number) })
    )
  })
})
