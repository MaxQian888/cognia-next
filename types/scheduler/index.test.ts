import { isRetryableTerminalReason, type TaskExecutionTerminalReason } from "./index"

describe("isRetryableTerminalReason", () => {
  it("refuses a retry for a run that stopped for want of an approver", () => {
    expect(isRetryableTerminalReason("needs-approval")).toBe(false)
  })

  it("keeps the generic failure paths retryable", () => {
    const retryable: (TaskExecutionTerminalReason | undefined)[] = [
      undefined,
      "executor-failure",
      "execution-error",
    ]
    for (const reason of retryable) expect(isRetryableTerminalReason(reason)).toBe(true)
  })

  it("treats a reason it does not know as retryable", () => {
    // Persisted rows type the field as `TaskExecutionTerminalReason | string`.
    expect(isRetryableTerminalReason("some-future-reason")).toBe(true)
  })
})
