import {
  CUSTOM_MODES_LABEL_KEY,
  CUSTOM_MODES_PERSIST_KEY,
  customModesSnapshot,
} from "./custom-modes"
import { createMemoryStorage } from "./helpers"
import type { SnapshotEnv } from "./types"

describe("customModesSnapshot", () => {
  it("uses the expected persist identifiers", () => {
    expect(customModesSnapshot.key).toBe(CUSTOM_MODES_PERSIST_KEY)
    expect(customModesSnapshot.labelKey).toBe(CUSTOM_MODES_LABEL_KEY)
    expect(customModesSnapshot.exposeAsDomain).toBe(true)
  })

  it("captures ISO-stringified Date payload as written by the live store", () => {
    const payload = {
      state: {
        customModes: {
          mode1: {
            id: "mode1",
            createdAt: "2024-01-01T00:00:00.000Z",
            updatedAt: "2024-01-02T00:00:00.000Z",
            lastUsedAt: "2024-01-03T00:00:00.000Z",
            label: "Test",
          },
        },
      },
      version: 0,
    }
    const { storage } = createMemoryStorage({
      [CUSTOM_MODES_PERSIST_KEY]: JSON.stringify(payload),
    })
    const env: SnapshotEnv = { storage }
    const snap = customModesSnapshot.read(env)
    expect(snap?.raw.state).toEqual(payload.state)
  })

  it("round-trips overwrite", () => {
    const { storage, data } = createMemoryStorage()
    const env: SnapshotEnv = { storage }
    customModesSnapshot.write(
      {
        key: CUSTOM_MODES_PERSIST_KEY,
        storeVersion: 0,
        snapshotFormatVersion: 1,
        raw: { state: { customModes: {} }, version: 0 },
        capturedAt: "2024-01-01T00:00:00.000Z",
      },
      "overwrite",
      env
    )
    expect(data.has(CUSTOM_MODES_PERSIST_KEY)).toBe(true)
  })

  it("returns null for missing key", () => {
    const { storage } = createMemoryStorage()
    const env: SnapshotEnv = { storage }
    expect(customModesSnapshot.read(env)).toBeNull()
  })
})
