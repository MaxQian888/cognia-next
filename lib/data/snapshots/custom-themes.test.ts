import {
  CUSTOM_THEMES_LABEL_KEY,
  CUSTOM_THEMES_PERSIST_KEY,
  customThemesSnapshot,
} from "./custom-themes"
import { createMemoryStorage } from "./helpers"
import type { SnapshotEnv } from "./types"

describe("customThemesSnapshot", () => {
  it("uses the documented persist + label keys", () => {
    expect(customThemesSnapshot.key).toBe(CUSTOM_THEMES_PERSIST_KEY)
    expect(customThemesSnapshot.labelKey).toBe(CUSTOM_THEMES_LABEL_KEY)
    expect(customThemesSnapshot.exposeAsDomain).toBe(true)
  })

  it("captures user-defined themes", () => {
    const payload = {
      state: {
        themes: { mine: { id: "mine", colors: { primary: "#fff" } } },
      },
      version: 0,
    }
    const { storage } = createMemoryStorage({
      [CUSTOM_THEMES_PERSIST_KEY]: JSON.stringify(payload),
    })
    const env: SnapshotEnv = { storage }
    expect(customThemesSnapshot.read(env)?.raw.state).toEqual(payload.state)
  })
})
