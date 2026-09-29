import {
  ISSUE_WAKEUP_PAUSE_TERMINAL_REASONS,
  issueWakeupEventSource,
  wakeupPauseReasonOf,
} from "./wakeup"

describe("issue wakeup vocabulary", () => {
  it("scopes every event source to one issue", () => {
    expect(issueWakeupEventSource("i1")).toBe("issue:i1")
  })

  it("round-trips every pause reason through its terminal reason", () => {
    for (const [reason, terminal] of Object.entries(ISSUE_WAKEUP_PAUSE_TERMINAL_REASONS)) {
      expect(wakeupPauseReasonOf(terminal)).toBe(reason)
    }
    expect(wakeupPauseReasonOf("auto-paused")).toBeUndefined()
    expect(wakeupPauseReasonOf(undefined)).toBeUndefined()
  })
})
