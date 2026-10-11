import { isGlanceSnapshot, isNewerSnapshot, GLANCE_SNAPSHOT_VERSION } from "./snapshot"

describe("isNewerSnapshot", () => {
  it("accepts anything when nothing is held", () => {
    expect(isNewerSnapshot(null, { epoch: 1, revision: 1 })).toBe(true)
    expect(isNewerSnapshot(null, { epoch: 0, revision: 0 })).toBe(true)
  })

  it("accepts a higher revision in the same epoch", () => {
    expect(isNewerSnapshot({ epoch: 5, revision: 3 }, { epoch: 5, revision: 4 })).toBe(true)
  })

  it("rejects an equal or lower revision in the same epoch", () => {
    expect(isNewerSnapshot({ epoch: 5, revision: 3 }, { epoch: 5, revision: 3 })).toBe(false)
    expect(isNewerSnapshot({ epoch: 5, revision: 3 }, { epoch: 5, revision: 2 })).toBe(false)
  })

  it("always takes a different epoch, even with a lower revision", () => {
    expect(isNewerSnapshot({ epoch: 5, revision: 900 }, { epoch: 6, revision: 1 })).toBe(true)
    expect(isNewerSnapshot({ epoch: 5, revision: 900 }, { epoch: 4, revision: 1 })).toBe(true)
  })
})

describe("isGlanceSnapshot", () => {
  const valid = {
    version: GLANCE_SNAPSHOT_VERSION,
    epoch: 1,
    revision: 2,
    generatedAt: 3,
    config: {},
    when: {},
    actions: [],
  }

  it("accepts the structural minimum", () => {
    expect(isGlanceSnapshot(valid)).toBe(true)
    expect(isGlanceSnapshot({ ...valid, fleet: null, extra: 1 })).toBe(true)
  })

  it.each([[null], [undefined], ["x"], [1], [true]])("rejects non-object %j", (value) => {
    expect(isGlanceSnapshot(value)).toBe(false)
  })

  it.each([
    ["wrong version", { version: 2 }],
    ["string version", { version: "1" }],
    ["missing version", { version: undefined }],
    ["string epoch", { epoch: "1" }],
    ["missing revision", { revision: undefined }],
    ["string generatedAt", { generatedAt: "now" }],
    ["null config", { config: null }],
    ["string config", { config: "x" }],
    ["missing config", { config: undefined }],
    ["null when", { when: null }],
    ["missing when", { when: undefined }],
    ["missing actions", { actions: undefined }],
    ["null actions", { actions: null }],
    ["object actions", { actions: {} }],
    ["string actions", { actions: "trayPanel.delegate" }],
  ])("rejects %s", (_name, patch) => {
    expect(isGlanceSnapshot({ ...valid, ...patch })).toBe(false)
  })
})
