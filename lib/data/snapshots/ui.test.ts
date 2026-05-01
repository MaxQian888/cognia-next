import { UI_LABEL_KEY, UI_PERSIST_KEY, uiSnapshot } from "./ui"
import { createMemoryStorage } from "./helpers"
import type { SnapshotEnv } from "./types"

describe("uiSnapshot", () => {
  it("declares persist + label keys and stays out of the domain menu", () => {
    expect(uiSnapshot.key).toBe(UI_PERSIST_KEY)
    expect(uiSnapshot.labelKey).toBe(UI_LABEL_KEY)
    expect(uiSnapshot.exposeAsDomain).toBe(false)
  })

  it("captures the layout prefs", () => {
    const payload = {
      state: {
        selectedGuild: "guild-1",
        showMemberList: true,
        scratchpadCollapsed: false,
      },
      version: 0,
    }
    const { storage } = createMemoryStorage({
      [UI_PERSIST_KEY]: JSON.stringify(payload),
    })
    const env: SnapshotEnv = { storage }
    expect(uiSnapshot.read(env)?.raw.state).toEqual(payload.state)
  })
})
