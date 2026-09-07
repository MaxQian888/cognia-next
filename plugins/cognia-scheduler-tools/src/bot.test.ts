import type { BotRunContextV1, ScheduledTask } from "@cognia/plugin-sdk"

import {
  DEFAULT_STALE_AFTER_DAYS,
  buildScheduleDigest,
  createScheduleDigestBot,
  describeScheduleDigest,
} from "./bot"

const NOW = 1_700_000_000_000
const DAY = 24 * 60 * 60_000

function task(over: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "task_1",
    name: "Nightly digest",
    type: "chat",
    trigger: { type: "cron", cronExpression: "0 9 * * *" },
    config: {},
    notification: {},
    status: "active",
    runCount: 0,
    successCount: 0,
    failureCount: 0,
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
    ...over,
  } as ScheduledTask
}

describe("buildScheduleDigest", () => {
  it("counts the three statuses a reader acts on", () => {
    const digest = buildScheduleDigest(
      [task(), task({ id: "b", status: "paused" }), task({ id: "c", status: "disabled" })],
      NOW
    )
    expect(digest).toMatchObject({ total: 3, active: 1, paused: 1 })
  })

  it("calls a task stale when its last run is older than the window", () => {
    const digest = buildScheduleDigest(
      [task({ lastRunAt: new Date(NOW - 20 * DAY) })],
      NOW,
      DEFAULT_STALE_AFTER_DAYS
    )
    expect(digest.stale).toEqual(["Nightly digest"])
  })

  it("calls a task that has NEVER run stale once it is older than the window", () => {
    // A task created six weeks ago that still has not fired is exactly what a
    // digest exists to surface. Keying on `lastRunAt` alone would skip it,
    // because there is no last run to be old.
    const digest = buildScheduleDigest([task({ createdAt: new Date(NOW - 40 * DAY) })], NOW)
    expect(digest.stale).toEqual(["Nightly digest"])
  })

  it("does not call a recently run task stale", () => {
    const digest = buildScheduleDigest([task({ lastRunAt: new Date(NOW - DAY) })], NOW)
    expect(digest.stale).toEqual([])
  })

  it("ignores a paused task's age, because a paused task is not meant to run", () => {
    const digest = buildScheduleDigest(
      [task({ status: "paused", createdAt: new Date(NOW - 40 * DAY) })],
      NOW
    )
    expect(digest.stale).toEqual([])
  })

  it("reads the failure COUNTER, not the stale error message", () => {
    // A task that failed once and has since succeeded keeps `lastError`. The
    // counter is what says it is failing now.
    const recovered = task({ lastError: "boom", consecutiveFailures: 0 })
    const failing = task({ id: "b", name: "Broken", lastError: "boom", consecutiveFailures: 3 })
    expect(buildScheduleDigest([recovered, failing], NOW).failing).toEqual(["Broken"])
  })

  it("honours a custom window", () => {
    const rows = [task({ lastRunAt: new Date(NOW - 5 * DAY) })]
    expect(buildScheduleDigest(rows, NOW, 3).stale).toEqual(["Nightly digest"])
    expect(buildScheduleDigest(rows, NOW, 30).stale).toEqual([])
  })

  it("floors the window at a day rather than dividing by zero into everything", () => {
    expect(buildScheduleDigest([task()], NOW, 0).stale).toEqual([])
  })
})

describe("describeScheduleDigest", () => {
  it("always states the active count", () => {
    expect(describeScheduleDigest({ total: 3, active: 1, paused: 0, stale: [], failing: [] })).toBe(
      "1 active of 3"
    )
  })

  it("mentions only the problems that exist", () => {
    expect(
      describeScheduleDigest({ total: 3, active: 2, paused: 1, stale: ["a"], failing: ["b"] })
    ).toBe("2 active of 3, 1 paused, 1 failing, 1 stale")
  })
})

describe("createScheduleDigestBot", () => {
  function context(over: Partial<BotRunContextV1> = {}): BotRunContextV1 {
    return {
      runId: "botrun_1",
      installationId: "boti_1",
      botId: "cognia-scheduler-tools:schedule-digest",
      event: {} as BotRunContextV1["event"],
      config: {},
      signal: new AbortController().signal,
      step: {
        run: async (_name, fn) => fn(),
        waitForApproval: jest.fn(),
        waitForEvent: jest.fn(),
      } as unknown as BotRunContextV1["step"],
      log: jest.fn(),
      progress: jest.fn(),
      ...over,
    }
  }

  it("reads the schedule inside a step, so a retry reports the first attempt's numbers", async () => {
    // The memoization is the point: on re-entry the digest is the one taken
    // when the run started, not a fresh snapshot of a schedule that moved.
    const run = jest.fn(async (_name: string, fn: () => unknown) => fn())
    const listTasks = jest.fn(async () => [task()])
    const handler = createScheduleDigestBot({ listTasks, now: () => NOW })
    await handler(context({ step: { run } as unknown as BotRunContextV1["step"] }))
    expect(run).toHaveBeenCalledWith("read-schedule", expect.any(Function))
  })

  it("returns a summary and the structured digest", async () => {
    const handler = createScheduleDigestBot({
      listTasks: async () => [task(), task({ id: "b", status: "paused" })],
      now: () => NOW,
    })
    const result = await handler(context())
    expect(result).toMatchObject({
      summary: "1 active of 2, 1 paused",
      output: { total: 2, active: 1, paused: 1 },
    })
  })

  it("takes the stale window from the installation's config", async () => {
    const handler = createScheduleDigestBot({
      listTasks: async () => [task({ lastRunAt: new Date(NOW - 5 * DAY) })],
      now: () => NOW,
    })
    const result = await handler(context({ config: { staleAfterDays: 3 } }))
    expect((result as { output: { stale: string[] } }).output.stale).toEqual(["Nightly digest"])
  })

  it("falls back to the default when the config carries the wrong type", async () => {
    // The schema says number. A row written before the field existed, or by a
    // hand-edited config, must not turn the window into NaN and mark
    // everything stale.
    const handler = createScheduleDigestBot({
      listTasks: async () => [task({ lastRunAt: new Date(NOW - DAY) })],
      now: () => NOW,
    })
    const result = await handler(context({ config: { staleAfterDays: "soon" } }))
    expect((result as { output: { stale: string[] } }).output.stale).toEqual([])
  })

  it("logs a warning when something is failing, and stays quiet when nothing is", async () => {
    const log = jest.fn()
    const failing = createScheduleDigestBot({
      listTasks: async () => [task({ consecutiveFailures: 2 })],
      now: () => NOW,
    })
    await failing(context({ log }))
    expect(log).toHaveBeenCalledWith("warn", "scheduled tasks are failing", {
      names: ["Nightly digest"],
    })

    const quiet = jest.fn()
    const healthy = createScheduleDigestBot({ listTasks: async () => [task()], now: () => NOW })
    await healthy(context({ log: quiet }))
    expect(quiet).not.toHaveBeenCalled()
  })

  it("lets a read failure throw, so the delivery retries instead of reporting zero", async () => {
    // A digest that swallowed the error would report an empty schedule, and
    // "nothing is scheduled" is a materially different answer from "I could
    // not look".
    const handler = createScheduleDigestBot({
      listTasks: async () => {
        throw new Error("scheduler-tools is not active")
      },
    })
    await expect(handler(context())).rejects.toThrow("not active")
  })
})
