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
  markBootIntroPlayed,
} from "@/lib/boot/boot-progress"

import { BOOT_ACTIVE_SHARE, deriveBootProgressView, useBootProgress } from "./use-boot-progress"

describe("deriveBootProgressView", () => {
  beforeEach(() => __resetBootProgressForTesting())

  it("lists every milestone from the caller's own when the store is pristine", () => {
    const view = deriveBootProgressView(getServerBootProgressSnapshot(), "accounts", true)
    expect(view.milestones.map((m) => `${m.id}:${m.status}`)).toEqual([
      "accounts:active",
      "preferences:pending",
      "interface:pending",
      "workspace:pending",
    ])
    expect(view.index).toBe(0)
    expect(view.total).toBe(4)
    expect(view.fraction).toBeCloseTo(BOOT_ACTIVE_SHARE / 4)
    expect(view.sequenceStartedAt).toBeNull()
    expect(view.playIntro).toBe(true)
  })

  it("normalises earlier rows to done from the caller's milestone, before the store catches up", () => {
    // Owner A is still registered as active; owner B renders before effects run.
    beginBootMilestone("accounts", 1000)
    const view = deriveBootProgressView(getBootProgressSnapshot(), "preferences", false)
    expect(view.milestones[0]).toEqual({ id: "accounts", status: "done", durationMs: null })
    expect(view.milestones[1]).toEqual({ id: "preferences", status: "active", durationMs: null })
    expect(view.milestones[2].status).toBe("pending")
    expect(view.index).toBe(1)
    expect(view.fraction).toBeCloseTo((1 + BOOT_ACTIVE_SHARE) / 4)
  })

  it("carries measured durations for milestones the store has closed", () => {
    beginBootMilestone("accounts", 1000)
    endBootMilestone("accounts", 1450)
    beginBootMilestone("preferences", 1450)
    const view = deriveBootProgressView(getBootProgressSnapshot(), "preferences", false)
    expect(view.milestones[0].durationMs).toBe(450)
  })

  it("hides milestones before the sequence start on a route transition", () => {
    beginBootMilestone("workspace", 5000)
    const view = deriveBootProgressView(getBootProgressSnapshot(), "workspace", false)
    expect(view.milestones.map((m) => m.id)).toEqual(["workspace"])
    expect(view.total).toBe(1)
    expect(view.index).toBe(0)
    expect(view.fraction).toBeCloseTo(BOOT_ACTIVE_SHARE)
  })

  it("never lets a stale later `first` hide the caller's own row", () => {
    beginBootMilestone("workspace", 5000)
    endBootMilestone("workspace", 5100)
    // The account gate re-mounts its loader before the store has been told.
    const view = deriveBootProgressView(getBootProgressSnapshot(), "accounts", false)
    expect(view.milestones[0]).toEqual({ id: "accounts", status: "active", durationMs: null })
    expect(view.total).toBe(4)
  })
})

describe("useBootProgress", () => {
  beforeEach(() => __resetBootProgressForTesting())

  it("registers the milestone for the life of the mount", () => {
    const { result, unmount } = renderHook(() => useBootProgress("accounts"))
    expect(getBootProgressSnapshot().active).toBe("accounts")
    expect(result.current.milestone).toBe("accounts")
    expect(result.current.milestones[0].status).toBe("active")
    expect(result.current.sequenceStartedAt).toEqual(expect.any(Number))
    unmount()
    expect(getBootProgressSnapshot().active).toBeNull()
    expect(getBootProgressSnapshot().milestones.accounts.status).toBe("done")
  })

  it("plays the entrance once per page load and latches it", () => {
    const first = renderHook(() => useBootProgress("accounts"))
    expect(first.result.current.playIntro).toBe(true)
    expect(getBootProgressSnapshot().introPlayed).toBe(true)
    first.unmount()

    const second = renderHook(() => useBootProgress("preferences"))
    expect(second.result.current.playIntro).toBe(false)
    second.unmount()
  })

  it("renders settled when an earlier owner already played the entrance", () => {
    markBootIntroPlayed()
    const { result } = renderHook(() => useBootProgress("workspace"))
    expect(result.current.playIntro).toBe(false)
  })

  it("keeps the sequence anchor across a hand-over", () => {
    const first = renderHook(() => useBootProgress("accounts"))
    const anchor = first.result.current.sequenceStartedAt
    first.unmount()
    const second = renderHook(() => useBootProgress("interface"))
    expect(second.result.current.sequenceStartedAt).toBe(anchor)
    expect(second.result.current.milestones.map((m) => `${m.id}:${m.status}`)).toEqual([
      "accounts:done",
      "preferences:done",
      "interface:active",
      "workspace:pending",
    ])
    second.unmount()
  })

  it("re-registers when the caller changes milestone", () => {
    const { result, rerender } = renderHook(({ m }) => useBootProgress(m), {
      initialProps: { m: "accounts" as const },
    })
    expect(result.current.index).toBe(0)
    act(() => {
      rerender({ m: "preferences" as never })
    })
    expect(getBootProgressSnapshot().active).toBe("preferences")
    expect(result.current.index).toBe(1)
    expect(result.current.milestones[0].status).toBe("done")
  })

  it("follows store updates published while mounted", () => {
    const { result } = renderHook(() => useBootProgress("workspace"))
    const before = result.current.sequenceStartedAt
    act(() => {
      // A stray earlier owner taking over resets the visible list.
      beginBootMilestone("accounts", (before ?? 0) + 10)
    })
    // The hook still stands for `workspace`, so its own row stays active and
    // the newly-active accounts row reads as done from this mount's view.
    expect(result.current.milestone).toBe("workspace")
    expect(result.current.total).toBe(4)
  })
})
