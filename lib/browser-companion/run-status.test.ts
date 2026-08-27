import type { ExecutionRunStatus } from "@/types/execution/run"

import { BROWSER_STATUS_WITHOUT_RUN, browserStatusForRun } from "./run-status"

describe("browserStatusForRun", () => {
  it("maps every runtime status without falling through", () => {
    const all: ExecutionRunStatus[] = [
      "queued",
      "running",
      "waiting",
      "paused",
      "recovery_required",
      "completed",
      "failed",
      "cancelled",
    ]
    for (const status of all) {
      expect(browserStatusForRun(status)).toBeDefined()
    }
  })

  it("collapses waiting and paused into one 'needs you' state", () => {
    // The panel offers no way to answer — it deep-links to Cognia — so two
    // states the user cannot tell apart from here would be noise.
    expect(browserStatusForRun("waiting")).toBe("needs_input")
    expect(browserStatusForRun("paused")).toBe("needs_input")
  })

  it("reports recovery_required as failed, not as needs_input", () => {
    // Calling it needs_input would invite the user to answer a prompt that is
    // not there. It sends them to the desktop, which is where it is fixable.
    expect(browserStatusForRun("recovery_required")).toBe("failed")
  })

  it("keeps the terminal states distinct", () => {
    expect(browserStatusForRun("completed")).toBe("completed")
    expect(browserStatusForRun("cancelled")).toBe("cancelled")
    expect(browserStatusForRun("failed")).toBe("failed")
  })

  it("treats a session with no run yet as queued, never failed", () => {
    // The first second of every successful submission looks like this.
    expect(BROWSER_STATUS_WITHOUT_RUN).toBe("queued")
  })
})
