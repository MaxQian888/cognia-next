import {
  BOOT_MILESTONES,
  BOOT_SEQUENCE_GAP_MS,
  __resetBootProgressForTesting,
  beginBootMilestone,
  bootMilestoneIndex,
  endBootMilestone,
  getBootProgressSnapshot,
  getServerBootProgressSnapshot,
  markBootIntroPlayed,
  subscribeBootProgress,
  visibleBootMilestones,
} from "./boot-progress"

describe("boot progress timeline", () => {
  beforeEach(() => __resetBootProgressForTesting())

  it("starts empty and exposes a frozen server snapshot", () => {
    const server = getServerBootProgressSnapshot()
    expect(server.active).toBeNull()
    expect(server.first).toBeNull()
    expect(server.introPlayed).toBe(false)
    expect(getBootProgressSnapshot()).toBe(server)
    for (const milestone of BOOT_MILESTONES) {
      expect(server.milestones[milestone].status).toBe("pending")
    }
  })

  it("orders milestones accounts → preferences → interface → workspace", () => {
    expect(BOOT_MILESTONES.map(bootMilestoneIndex)).toEqual([0, 1, 2, 3])
  })

  it("begins a sequence at the first milestone an owner declares", () => {
    beginBootMilestone("accounts", 1000)
    const snap = getBootProgressSnapshot()
    expect(snap.active).toBe("accounts")
    expect(snap.first).toBe("accounts")
    expect(snap.sequenceStartedAt).toBe(1000)
    expect(snap.milestones.accounts).toEqual({
      status: "active",
      startedAt: 1000,
      completedAt: null,
      durationMs: null,
    })
    expect(snap.milestones.preferences.status).toBe("pending")
  })

  it("measures a milestone when its owner unmounts and keeps the sequence open", () => {
    beginBootMilestone("accounts", 1000)
    endBootMilestone("accounts", 1400)
    const snap = getBootProgressSnapshot()
    expect(snap.active).toBeNull()
    expect(snap.first).toBe("accounts")
    expect(snap.milestones.accounts).toEqual({
      status: "done",
      startedAt: 1000,
      completedAt: 1400,
      durationMs: 400,
    })
  })

  it("continues the same sequence across a hand-over inside the gap", () => {
    beginBootMilestone("accounts", 1000)
    endBootMilestone("accounts", 1400)
    beginBootMilestone("preferences", 1400 + BOOT_SEQUENCE_GAP_MS)
    const snap = getBootProgressSnapshot()
    expect(snap.first).toBe("accounts")
    expect(snap.sequenceStartedAt).toBe(1000)
    expect(snap.active).toBe("preferences")
    expect(snap.milestones.accounts.durationMs).toBe(400)
  })

  it("starts a fresh sequence once the app has been interactive past the gap", () => {
    beginBootMilestone("accounts", 1000)
    endBootMilestone("accounts", 1400)
    markBootIntroPlayed()
    beginBootMilestone("workspace", 1400 + BOOT_SEQUENCE_GAP_MS + 1)
    const snap = getBootProgressSnapshot()
    expect(snap.first).toBe("workspace")
    expect(snap.sequenceStartedAt).toBe(1400 + BOOT_SEQUENCE_GAP_MS + 1)
    // The entrance is a once-per-page-load affair; a later wait does not
    // re-animate in front of the user.
    expect(snap.introPlayed).toBe(true)
    // The old measurement belongs to the previous wait.
    expect(snap.milestones.accounts).toEqual({
      status: "done",
      startedAt: null,
      completedAt: null,
      durationMs: null,
    })
  })

  it("marks passed-over milestones done without inventing a duration", () => {
    beginBootMilestone("accounts", 1000)
    endBootMilestone("accounts", 1200)
    // The desktop-only recovery/onboarding owners resolved synchronously and
    // never mounted a loader; the shell hands straight over to `interface`.
    beginBootMilestone("interface", 1200)
    const snap = getBootProgressSnapshot()
    expect(snap.milestones.preferences).toEqual({
      status: "done",
      startedAt: null,
      completedAt: null,
      durationMs: null,
    })
    expect(snap.milestones.accounts.durationMs).toBe(200)
    expect(snap.active).toBe("interface")
  })

  it("closes an owner that never unmounted when a later owner takes over", () => {
    beginBootMilestone("accounts", 1000)
    beginBootMilestone("preferences", 1300)
    const snap = getBootProgressSnapshot()
    expect(snap.milestones.accounts).toEqual({
      status: "done",
      startedAt: 1000,
      completedAt: 1300,
      durationMs: 300,
    })
    expect(snap.first).toBe("accounts")
    expect(snap.active).toBe("preferences")
  })

  it("resets later milestones to pending when an earlier owner re-mounts", () => {
    beginBootMilestone("accounts", 1000)
    endBootMilestone("accounts", 1100)
    beginBootMilestone("workspace", 1100)
    endBootMilestone("workspace", 1200)
    // Same sequence (inside the gap), but the account gate re-locked and
    // mounted its loader again — the workspace step must not stay ticked.
    beginBootMilestone("accounts", 1300)
    const snap = getBootProgressSnapshot()
    expect(snap.milestones.workspace.status).toBe("pending")
    expect(snap.active).toBe("accounts")
  })

  it("widens the visible list when an earlier owner joins a later-started sequence", () => {
    beginBootMilestone("workspace", 1000)
    endBootMilestone("workspace", 1100)
    beginBootMilestone("accounts", 1200)
    expect(getBootProgressSnapshot().first).toBe("accounts")
    expect(visibleBootMilestones(getBootProgressSnapshot(), "workspace")).toEqual([
      ...BOOT_MILESTONES,
    ])
  })

  it("is idempotent for the milestone already active", () => {
    beginBootMilestone("accounts", 1000)
    const before = getBootProgressSnapshot()
    beginBootMilestone("accounts", 5000)
    expect(getBootProgressSnapshot()).toBe(before)
  })

  it("ignores an end for a milestone that is not active", () => {
    beginBootMilestone("accounts", 1000)
    const before = getBootProgressSnapshot()
    endBootMilestone("workspace", 2000)
    expect(getBootProgressSnapshot()).toBe(before)
    endBootMilestone("accounts", 2000)
    endBootMilestone("accounts", 3000)
    expect(getBootProgressSnapshot().milestones.accounts.completedAt).toBe(2000)
  })

  it("latches the intro flag once per page load and notifies subscribers", () => {
    const listener = jest.fn()
    const unsubscribe = subscribeBootProgress(listener)
    beginBootMilestone("accounts", 1000)
    expect(listener).toHaveBeenCalledTimes(1)
    markBootIntroPlayed()
    expect(getBootProgressSnapshot().introPlayed).toBe(true)
    expect(listener).toHaveBeenCalledTimes(2)
    markBootIntroPlayed()
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
    endBootMilestone("accounts", 1100)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it("bumps the version on every change", () => {
    const v0 = getBootProgressSnapshot().version
    beginBootMilestone("accounts", 1000)
    const v1 = getBootProgressSnapshot().version
    endBootMilestone("accounts", 1100)
    const v2 = getBootProgressSnapshot().version
    expect(v1).toBeGreaterThan(v0)
    expect(v2).toBeGreaterThan(v1)
  })

  describe("visibleBootMilestones", () => {
    it("lists every milestone for a cold boot", () => {
      beginBootMilestone("accounts", 1000)
      expect(visibleBootMilestones(getBootProgressSnapshot(), "workspace")).toEqual([
        ...BOOT_MILESTONES,
      ])
    })

    it("hides the steps a route transition never runs", () => {
      beginBootMilestone("workspace", 1000)
      expect(visibleBootMilestones(getBootProgressSnapshot(), "accounts")).toEqual(["workspace"])
    })

    it("falls back to the caller's milestone before any owner has spoken", () => {
      expect(visibleBootMilestones(getServerBootProgressSnapshot(), "interface")).toEqual([
        "interface",
        "workspace",
      ])
    })
  })
})
