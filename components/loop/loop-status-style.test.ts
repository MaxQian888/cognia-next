import { loopStatusStyle } from "./loop-status-style"

describe("loopStatusStyle", () => {
  it("maps active to a pulsing success chip", () => {
    const s = loopStatusStyle("active")
    expect(s.tone).toBe("active")
    expect(s.pulse).toBe(true)
    expect(s.chip).toContain("success")
  })

  it("maps paused to warning without pulse", () => {
    const s = loopStatusStyle("paused")
    expect(s.tone).toBe("paused")
    expect(s.pulse).toBe(false)
    expect(s.chip).toContain("warning")
  })

  it("maps completed to the done tone", () => {
    expect(loopStatusStyle("completed").tone).toBe("done")
  })

  it("maps cap/expiry/error exits to the halted tone", () => {
    for (const status of ["iteration_limited", "budget_limited", "expired", "error"] as const) {
      expect(loopStatusStyle(status).tone).toBe("halted")
    }
  })

  it("maps stopped to neutral", () => {
    expect(loopStatusStyle("stopped").tone).toBe("neutral")
  })
})
