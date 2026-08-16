import {
  __resetMobileBootForTesting,
  beginMobileBootStage,
  endMobileBootStage,
  getMobileBootSnapshot,
  getServerMobileBootSnapshot,
  markMobileBootIntroPlayed,
  markMobileBootSettled,
  MOBILE_BOOT_STAGES,
  mobileBootStageIndex,
  setMobileBootOverlayVisible,
  skipMobileBootStagesAfter,
  subscribeMobileBoot,
} from "./mobile-boot-stages"

describe("mobile-boot-stages", () => {
  beforeEach(() => {
    __resetMobileBootForTesting()
  })

  it("starts pristine, and the server snapshot is the pristine one", () => {
    const snap = getMobileBootSnapshot()
    expect(snap).toBe(getServerMobileBootSnapshot())
    expect(snap.active).toBeNull()
    expect(snap.settled).toBe(false)
    expect(snap.overlayVisible).toBe(false)
    expect(snap.introPlayed).toBe(false)
    for (const stage of MOBILE_BOOT_STAGES) {
      expect(snap.stages[stage].status).toBe("pending")
    }
    expect(mobileBootStageIndex("host")).toBe(2)
  })

  it("begins and ends a stage with a measured duration", () => {
    const listener = jest.fn()
    const unsubscribe = subscribeMobileBoot(listener)

    beginMobileBootStage("bridge", 1000)
    expect(getMobileBootSnapshot().active).toBe("bridge")
    expect(getMobileBootSnapshot().stages.bridge).toMatchObject({
      status: "active",
      startedAt: 1000,
      completedAt: null,
      durationMs: null,
    })

    endMobileBootStage("bridge", { detail: "registered" }, 1250)
    const snap = getMobileBootSnapshot()
    expect(snap.active).toBeNull()
    expect(snap.stages.bridge).toEqual({
      status: "done",
      detail: "registered",
      startedAt: 1000,
      completedAt: 1250,
      durationMs: 250,
    })
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
    beginMobileBootStage("companion")
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it("is idempotent for the stage already active", () => {
    beginMobileBootStage("bridge", 10)
    const before = getMobileBootSnapshot()
    beginMobileBootStage("bridge", 20)
    expect(getMobileBootSnapshot()).toBe(before)
  })

  it("records failed and skipped outcomes, skipped defaulting to notNeeded", () => {
    beginMobileBootStage("host", 5)
    endMobileBootStage("host", { status: "failed", detail: "offline" }, 15)
    expect(getMobileBootSnapshot().stages.host).toMatchObject({
      status: "failed",
      detail: "offline",
      durationMs: 10,
    })
    endMobileBootStage("sync", { status: "skipped" }, 16)
    expect(getMobileBootSnapshot().stages.sync).toEqual({
      status: "skipped",
      detail: "notNeeded",
      startedAt: null,
      completedAt: 16,
      durationMs: null,
    })
  })

  it("skipMobileBootStagesAfter marks only later, still-pending stages", () => {
    beginMobileBootStage("bridge", 1)
    endMobileBootStage("bridge", {}, 2)
    beginMobileBootStage("companion", 3)
    endMobileBootStage("companion", { detail: "standalone" }, 4)
    skipMobileBootStagesAfter("companion", 5)
    const { stages } = getMobileBootSnapshot()
    expect(stages.bridge.status).toBe("done")
    expect(stages.companion.status).toBe("done")
    expect(stages.host).toMatchObject({ status: "skipped", detail: "notNeeded", completedAt: 5 })
    expect(stages.sync).toMatchObject({ status: "skipped", detail: "notNeeded", completedAt: 5 })
    // Already-ended stages are left alone.
    endMobileBootStage("host", { status: "failed", detail: "offline" }, 6)
    skipMobileBootStagesAfter("companion", 7)
    expect(getMobileBootSnapshot().stages.host.status).toBe("failed")
  })

  it("ending a stage that is not active leaves the active stage alone", () => {
    beginMobileBootStage("companion", 1)
    endMobileBootStage("bridge", { detail: "registered" }, 2)
    expect(getMobileBootSnapshot().active).toBe("companion")
    expect(getMobileBootSnapshot().stages.bridge.status).toBe("done")
    expect(getMobileBootSnapshot().stages.bridge.durationMs).toBeNull()
  })

  it("re-beginning an ended stage reopens it, resets later stages and clears settled", () => {
    beginMobileBootStage("companion", 1)
    endMobileBootStage("companion", { detail: "paired" }, 2)
    beginMobileBootStage("host", 3)
    endMobileBootStage("host", { detail: "linked" }, 4)
    markMobileBootSettled()
    beginMobileBootStage("sync", 5)
    expect(getMobileBootSnapshot().settled).toBe(true)

    // Pairing changed → host bindings restart from the companion stage.
    beginMobileBootStage("companion", 10)
    const snap = getMobileBootSnapshot()
    expect(snap.active).toBe("companion")
    expect(snap.settled).toBe(false)
    expect(snap.stages.companion.status).toBe("active")
    expect(snap.stages.host.status).toBe("pending")
    expect(snap.stages.sync.status).toBe("pending")
  })

  it("settled, overlayVisible and introPlayed only publish on change", () => {
    const listener = jest.fn()
    subscribeMobileBoot(listener)
    markMobileBootSettled()
    markMobileBootSettled()
    expect(getMobileBootSnapshot().settled).toBe(true)
    setMobileBootOverlayVisible(true)
    setMobileBootOverlayVisible(true)
    setMobileBootOverlayVisible(false)
    expect(getMobileBootSnapshot().overlayVisible).toBe(false)
    markMobileBootIntroPlayed()
    markMobileBootIntroPlayed()
    expect(getMobileBootSnapshot().introPlayed).toBe(true)
    expect(listener).toHaveBeenCalledTimes(4)
  })

  it("reset returns to the pristine snapshot and notifies", () => {
    const listener = jest.fn()
    subscribeMobileBoot(listener)
    beginMobileBootStage("bridge")
    __resetMobileBootForTesting()
    expect(getMobileBootSnapshot()).toBe(getServerMobileBootSnapshot())
    expect(listener).toHaveBeenCalledTimes(2)
  })
})
