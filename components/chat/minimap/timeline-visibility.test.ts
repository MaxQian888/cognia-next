import { shouldMountTimeline, TIMELINE_MIN_PANE_PX } from "./timeline-visibility"

const base = {
  paneWidth: 1200,
  isMobile: false,
  enabled: undefined as boolean | undefined,
  messageCount: 20,
  threshold: 8,
}

describe("shouldMountTimeline", () => {
  it("mounts on a wide pointer pane with a long enough conversation", () => {
    expect(shouldMountTimeline(base)).toBe(true)
  })

  it("never mounts on mobile, however wide the pane reports", () => {
    expect(shouldMountTimeline({ ...base, isMobile: true })).toBe(false)
  })

  it("respects an explicit opt-out", () => {
    expect(shouldMountTimeline({ ...base, enabled: false })).toBe(false)
  })

  it("treats an unset preference as opted in", () => {
    expect(shouldMountTimeline({ ...base, enabled: undefined })).toBe(true)
    expect(shouldMountTimeline({ ...base, enabled: true })).toBe(true)
  })

  it("stays unmounted until the conversation passes the threshold", () => {
    expect(shouldMountTimeline({ ...base, messageCount: 8 })).toBe(false)
    expect(shouldMountTimeline({ ...base, messageCount: 9 })).toBe(true)
  })

  // The reason this predicate exists: a viewport query said "wide" while the
  // pane was 700px, and the 256px panel landed on the reading column.
  it("stays unmounted when the pane is narrower than the minimum", () => {
    expect(shouldMountTimeline({ ...base, paneWidth: TIMELINE_MIN_PANE_PX - 1 })).toBe(false)
    expect(shouldMountTimeline({ ...base, paneWidth: TIMELINE_MIN_PANE_PX })).toBe(true)
  })

  it("treats an unmeasured pane as too narrow rather than mounting on 0", () => {
    expect(shouldMountTimeline({ ...base, paneWidth: 0 })).toBe(false)
  })

  it("pins the minimum to the Tailwind @4xl breakpoint the CSS gate uses", () => {
    // 56rem × 16px/rem. If this moves, `@4xl/message-list` in
    // conversation-timeline.tsx must move with it.
    expect(TIMELINE_MIN_PANE_PX).toBe(896)
  })
})
