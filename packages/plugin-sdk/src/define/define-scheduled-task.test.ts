import { defineScheduledTask } from "./define-scheduled-task"

describe("defineScheduledTask", () => {
  it("returns the scheduled task contribution unchanged", () => {
    const def = {
      name: "nightly-summary",
      description: "Build a nightly summary.",
      handler: "runNightlySummary",
      trigger: { type: "cron" as const, expression: "0 22 * * *", timezone: "UTC" },
      defaultEnabled: true,
    }

    expect(defineScheduledTask(def)).toBe(def)
  })
})
