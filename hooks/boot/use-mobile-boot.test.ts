/**
 * @jest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react"

import {
  __resetBootProgressForTesting,
  beginBootMilestone,
  endBootMilestone,
  getBootProgressSnapshot,
  getServerBootProgressSnapshot,
} from "@/lib/boot/boot-progress"
import {
  __resetMobileBootForTesting,
  beginMobileBootStage,
  endMobileBootStage,
  getMobileBootSnapshot,
  getServerMobileBootSnapshot,
  markMobileBootIntroPlayed,
  markMobileBootSettled,
  skipMobileBootStagesAfter,
} from "@/lib/boot/mobile-boot-stages"

import {
  deriveMobileBootView,
  GATE_SEEN_AFTER_MS,
  MOBILE_BOOT_ACTIVE_SHARE,
  useMobileBoot,
} from "./use-mobile-boot"

const ids = (view: ReturnType<typeof deriveMobileBootView>) =>
  view.rows.map((row) => `${row.id}:${row.status}`)

describe("deriveMobileBootView", () => {
  beforeEach(() => {
    __resetBootProgressForTesting()
    __resetMobileBootForTesting()
  })

  it("lists the shared milestones then the Capacitor stages for a cold-boot gate", () => {
    const view = deriveMobileBootView(
      getServerBootProgressSnapshot(),
      getServerMobileBootSnapshot(),
      "accounts",
      true
    )
    expect(view.layout).toBe("boot")
    expect(ids(view)).toEqual([
      "accounts:active",
      "preferences:pending",
      "bridge:pending",
      "companion:pending",
      "host:pending",
      "sync:pending",
    ])
    expect(view.activeId).toBe("accounts")
    expect(view.completed).toBe(0)
    expect(view.total).toBe(6)
    expect(view.fraction).toBeCloseTo(MOBILE_BOOT_ACTIVE_SHARE / 6)
    expect(view.settled).toBe(false)
    expect(view.playIntro).toBe(true)
  })

  it("normalises milestone rows from the caller's own milestone before the store catches up", () => {
    beginBootMilestone("accounts", 1000)
    const view = deriveMobileBootView(
      getBootProgressSnapshot(),
      getMobileBootSnapshot(),
      "preferences",
      false
    )
    expect(view.rows[0]).toEqual({
      id: "accounts",
      kind: "milestone",
      status: "done",
      detail: null,
      durationMs: null,
    })
    expect(view.rows[1].status).toBe("active")
    expect(view.activeId).toBe("preferences")
  })

  it("treats every milestone as behind the overlay and mirrors the stage store", () => {
    beginBootMilestone("accounts", 1000)
    endBootMilestone("accounts", 1400)
    beginBootMilestone("preferences", 1400)
    endBootMilestone("preferences", 1900)
    beginMobileBootStage("bridge", 1900)
    endMobileBootStage("bridge", { detail: "registered" }, 1950)
    beginMobileBootStage("companion", 1950)
    endMobileBootStage("companion", { detail: "paired" }, 2100)
    beginMobileBootStage("host", 2100)

    const view = deriveMobileBootView(
      getBootProgressSnapshot(),
      getMobileBootSnapshot(),
      null,
      true
    )
    expect(ids(view)).toEqual([
      "accounts:done",
      "preferences:done",
      "bridge:done",
      "companion:done",
      "host:active",
      "sync:pending",
    ])
    expect(view.rows[0].durationMs).toBe(400)
    expect(view.rows[2]).toMatchObject({ kind: "stage", detail: "registered", durationMs: 50 })
    expect(view.rows[3].detail).toBe("paired")
    expect(view.rows[4].durationMs).toBeNull()
    expect(view.activeId).toBe("host")
    expect(view.completed).toBe(4)
    expect(view.fraction).toBeCloseTo((4 + MOBILE_BOOT_ACTIVE_SHARE) / 6)
    expect(view.sequenceStartedAt).toBe(1000)
  })

  it("counts failed and skipped stages as completed and reports settled", () => {
    beginMobileBootStage("companion", 1)
    endMobileBootStage("companion", { detail: "standalone" }, 2)
    skipMobileBootStagesAfter("companion", 3)
    markMobileBootSettled()
    const view = deriveMobileBootView(
      getBootProgressSnapshot(),
      getMobileBootSnapshot(),
      null,
      false
    )
    expect(ids(view).slice(3)).toEqual(["companion:done", "host:skipped", "sync:skipped"])
    expect(view.rows[4].detail).toBe("notNeeded")
    expect(view.activeId).toBeNull()
    expect(view.completed).toBe(5)
    expect(view.fraction).toBeCloseTo(5 / 6)
    expect(view.settled).toBe(true)
  })

  it("caps the fraction at 1 once everything has ended", () => {
    beginMobileBootStage("bridge", 1)
    endMobileBootStage("bridge", {}, 2)
    beginMobileBootStage("companion", 2)
    endMobileBootStage("companion", { detail: "paired" }, 3)
    beginMobileBootStage("host", 3)
    endMobileBootStage("host", { status: "failed", detail: "offline" }, 4)
    skipMobileBootStagesAfter("host", 5)
    const view = deriveMobileBootView(
      getBootProgressSnapshot(),
      getMobileBootSnapshot(),
      null,
      false
    )
    expect(view.completed).toBe(6)
    expect(view.fraction).toBe(1)
    expect(view.rows[4]).toMatchObject({ status: "failed", detail: "offline", durationMs: 1 })
  })

  it("reports the compact route layout for a workspace wait that starts its own sequence", () => {
    beginBootMilestone("workspace", 9000)
    const view = deriveMobileBootView(
      getBootProgressSnapshot(),
      getMobileBootSnapshot(),
      "workspace",
      false
    )
    expect(view.layout).toBe("route")
    expect(ids(view)).toEqual(["workspace:active"])
    expect(view.activeId).toBe("workspace")
    expect(view.total).toBe(1)
    expect(view.fraction).toBe(MOBILE_BOOT_ACTIVE_SHARE)
    expect(view.settled).toBe(false)
    expect(view.sequenceStartedAt).toBe(9000)
  })

  it("uses the route layout before the store has been told anything about a workspace wait", () => {
    const view = deriveMobileBootView(
      getServerBootProgressSnapshot(),
      getServerMobileBootSnapshot(),
      "workspace",
      true
    )
    expect(view.layout).toBe("route")
  })

  it("keeps the full boot layout for the workspace step of a cold boot", () => {
    beginBootMilestone("accounts", 100)
    endBootMilestone("accounts", 200)
    beginBootMilestone("workspace", 250)
    const view = deriveMobileBootView(
      getBootProgressSnapshot(),
      getMobileBootSnapshot(),
      "workspace",
      false
    )
    expect(view.layout).toBe("boot")
    expect(ids(view).slice(0, 2)).toEqual(["accounts:done", "preferences:done"])
    expect(view.activeId).toBeNull()
  })
})

describe("useMobileBoot", () => {
  beforeEach(() => {
    __resetBootProgressForTesting()
    __resetMobileBootForTesting()
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it("registers ownership of the milestone for the life of the mount", () => {
    const { result, unmount } = renderHook(() => useMobileBoot("accounts"))
    expect(getBootProgressSnapshot().active).toBe("accounts")
    expect(result.current.rows[0].status).toBe("active")
    unmount()
    expect(getBootProgressSnapshot().active).toBeNull()
    expect(getBootProgressSnapshot().milestones.accounts.status).toBe("done")
  })

  it("does not register anything for the overlay and re-renders on stage changes", () => {
    const { result } = renderHook(() => useMobileBoot(null))
    expect(getBootProgressSnapshot().active).toBeNull()
    expect(result.current.rows[2].status).toBe("pending")
    act(() => {
      beginMobileBootStage("bridge")
    })
    expect(result.current.rows[2].status).toBe("active")
    expect(result.current.activeId).toBe("bridge")
    act(() => {
      endMobileBootStage("bridge", { detail: "registered" })
      markMobileBootSettled()
    })
    expect(result.current.rows[2].status).toBe("done")
    expect(result.current.settled).toBe(true)
  })

  it("the overlay latches the intro immediately; a gate only after it has been seen", () => {
    const gate = renderHook(() => useMobileBoot("accounts"))
    expect(gate.result.current.playIntro).toBe(true)
    // Unmounted before the native splash floor: never counted as seen.
    act(() => {
      jest.advanceTimersByTime(GATE_SEEN_AFTER_MS - 1)
    })
    gate.unmount()
    expect(getMobileBootSnapshot().introPlayed).toBe(false)

    const overlay = renderHook(() => useMobileBoot(null))
    expect(overlay.result.current.playIntro).toBe(true)
    expect(getMobileBootSnapshot().introPlayed).toBe(true)
    // The shared desktop latch is left alone.
    expect(getBootProgressSnapshot().introPlayed).toBe(false)

    // Anything mounting afterwards renders settled.
    const later = renderHook(() => useMobileBoot("workspace"))
    expect(later.result.current.playIntro).toBe(false)
  })

  it("a gate that outlives the native splash floor latches the intro", () => {
    renderHook(() => useMobileBoot("preferences"))
    act(() => {
      jest.advanceTimersByTime(GATE_SEEN_AFTER_MS)
    })
    expect(getMobileBootSnapshot().introPlayed).toBe(true)
  })

  it("respects an intro that was already played", () => {
    markMobileBootIntroPlayed()
    const { result } = renderHook(() => useMobileBoot(null))
    expect(result.current.playIntro).toBe(false)
  })
})
