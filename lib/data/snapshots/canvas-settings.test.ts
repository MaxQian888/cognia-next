import {
  CANVAS_SETTINGS_LABEL_KEY,
  CANVAS_SETTINGS_PERSIST_KEY,
  canvasSettingsSnapshot,
} from "./canvas-settings"
import { createMemoryStorage } from "./helpers"
import type { SnapshotEnv } from "./types"

describe("canvasSettingsSnapshot", () => {
  it("declares persist + label keys", () => {
    expect(canvasSettingsSnapshot.key).toBe(CANVAS_SETTINGS_PERSIST_KEY)
    expect(canvasSettingsSnapshot.labelKey).toBe(CANVAS_SETTINGS_LABEL_KEY)
    expect(canvasSettingsSnapshot.exposeAsDomain).toBe(true)
  })

  it("captures the prefs object", () => {
    const payload = {
      state: { font: "Fira Code", lineNumbers: true, autosaveMs: 3000 },
      version: 0,
    }
    const { storage } = createMemoryStorage({
      [CANVAS_SETTINGS_PERSIST_KEY]: JSON.stringify(payload),
    })
    const env: SnapshotEnv = { storage }
    expect(canvasSettingsSnapshot.read(env)?.raw.state).toEqual(payload.state)
  })
})
