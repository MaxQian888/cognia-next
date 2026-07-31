import { decideRunToast, isTerminalRunStatus } from "./run-progress-toast"

describe("decideRunToast", () => {
  it("starts a toast for a freshly-observed active run", () => {
    expect(decideRunToast(undefined, "running")).toBe("start")
    expect(decideRunToast(undefined, "pending")).toBe("start")
  })

  it("does NOT toast a run already terminal at first observation", () => {
    expect(decideRunToast(undefined, "succeeded")).toBe("none")
    expect(decideRunToast(undefined, "failed")).toBe("none")
    expect(decideRunToast(undefined, "cancelled")).toBe("none")
  })

  it("resolves an active → succeeded transition to success", () => {
    expect(decideRunToast("running", "succeeded")).toBe("success")
    expect(decideRunToast("waiting", "succeeded")).toBe("success")
  })

  it("resolves an active → failed/cancelled transition to error", () => {
    expect(decideRunToast("running", "failed")).toBe("error")
    expect(decideRunToast("running", "cancelled")).toBe("error")
  })

  it("returns none for unchanged status and intermediate active transitions", () => {
    expect(decideRunToast("running", "running")).toBe("none")
    expect(decideRunToast("pending", "running")).toBe("none")
    expect(decideRunToast("succeeded", "succeeded")).toBe("none")
  })
})

describe("isTerminalRunStatus", () => {
  it("identifies terminal states", () => {
    expect(isTerminalRunStatus("succeeded")).toBe(true)
    expect(isTerminalRunStatus("failed")).toBe(true)
    expect(isTerminalRunStatus("cancelled")).toBe(true)
    expect(isTerminalRunStatus("running")).toBe(false)
    expect(isTerminalRunStatus("pending")).toBe(false)
  })
})
