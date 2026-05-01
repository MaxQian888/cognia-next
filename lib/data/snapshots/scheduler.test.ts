import { SCHEDULER_LABEL_KEY, SCHEDULER_PERSIST_KEY, schedulerSnapshot } from "./scheduler"
import { createMemoryStorage } from "./helpers"
import type { SnapshotEnv } from "./types"

describe("schedulerSnapshot", () => {
  it("declares persist + label keys", () => {
    expect(schedulerSnapshot.key).toBe(SCHEDULER_PERSIST_KEY)
    expect(schedulerSnapshot.labelKey).toBe(SCHEDULER_LABEL_KEY)
    expect(schedulerSnapshot.exposeAsDomain).toBe(true)
  })

  it("captures the small UI prefs object", () => {
    const payload = {
      state: { filter: "all", interval: "weekly", policy: "manual" },
      version: 0,
    }
    const { storage } = createMemoryStorage({
      [SCHEDULER_PERSIST_KEY]: JSON.stringify(payload),
    })
    const env: SnapshotEnv = { storage }
    expect(schedulerSnapshot.read(env)?.raw.state).toEqual(payload.state)
  })
})
